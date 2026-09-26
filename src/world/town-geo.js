// Geometry kit for the town (world/town.js): one growable indexed buffer per material, primitives emitted straight
// into it in a local frame (origin + yaw), so hundreds of houses become a handful of merged draw calls without
// allocating a BufferGeometry per part. Owner: world (W).
//
//   const b = new Builder()                      attributes: position, normal, uv (metres), aP (vec2: part, seed)
//   b.frame(x, y, z, yaw)                        local → world: rotate about +y by yaw, then translate
//   b.part(p, seed)                              current part id / per-object random seed written into aP
//   b.quad(a, b, c, d)                           a..d local [x,y,z], counter-clockwise seen from the front
//   b.face(c, u, v, hu, hv)                      rectangle centred at c spanning ±hu·u, ±hv·v (normal u×v)
//   b.box(x0, y0, z0, x1, y1, z1, skip?)         axis-aligned (local) box; skip = bitmask of faces to omit (FACE.*)
//   b.obox(c, ex, ey, ez, hx, hy, hz)            oriented box (ex, ey, ez right-handed unit axes)
//   b.beam(a, b, w, h, up?)                      box from a to b (w across, h along `up`)
//   b.cyl(x, y, z, r0, r1, h, seg, caps?)        y-axis frustum standing on (x, y, z)
//   b.lathe(x, y, z, prof [[r, y]...], seg, sx?, sy?)
//   b.grid(nu, nv, f(i, j, out) → out.{x,y,z,u,v[,p,s]}, flip?)   parametric surface, smooth normals from the grid
//   b.geometry()                                 → THREE.BufferGeometry (Float32 / Uint32)
import * as THREE from 'three';

export const FACE = { PX: 1, NX: 2, PY: 4, NY: 8, PZ: 16, NZ: 32 };

class Grow {
  constructor(n = 4096) { this.a = new Float32Array(n); this.n = 0; }
  push3(x, y, z) { if (this.n + 3 > this.a.length) this._grow(); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3; }
  push2(x, y) { if (this.n + 2 > this.a.length) this._grow(); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; this.n = n + 2; }
  _grow() { const b = new this.a.constructor(this.a.length * 2); b.set(this.a); this.a = b; }
  view() { return this.a.slice(0, this.n); }
}
class GrowU32 extends Grow {
  constructor(n = 4096) { super(0); this.a = new Uint32Array(n); }
  push1(v) { if (this.n + 1 > this.a.length) this._grow(); this.a[this.n++] = v; }
}

const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0], _d = [0, 0, 0];
const sub = (p, q, o) => { o[0] = p[0] - q[0]; o[1] = p[1] - q[1]; o[2] = p[2] - q[2]; return o; };
const cross = (p, q, o) => { const x = p[1] * q[2] - p[2] * q[1], y = p[2] * q[0] - p[0] * q[2], z = p[0] * q[1] - p[1] * q[0]; o[0] = x; o[1] = y; o[2] = z; return o; };
const norm = (p) => { const l = Math.hypot(p[0], p[1], p[2]) || 1; p[0] /= l; p[1] /= l; p[2] /= l; return p; };
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

export class Builder {
  constructor() {
    this.P = new Grow(); this.N = new Grow(); this.U = new Grow(); this.A = new Grow(); this.I = new GrowU32();
    this.nv = 0;
    this.ox = 0; this.oy = 0; this.oz = 0; this.c = 1; this.s = 0;
    this.p = 0; this.sd = 0;
  }
  frame(x = 0, y = 0, z = 0, yaw = 0) { this.ox = x; this.oy = y; this.oz = z; this.c = Math.cos(yaw); this.s = Math.sin(yaw); return this; }
  part(p, seed = this.sd) { this.p = p; this.sd = seed; return this; }
  get tris() { return this.I.n / 3; }

  /** One vertex in LOCAL coordinates (position + normal), uv in metres. Returns its index. */
  v(x, y, z, nx, ny, nz, u, w) {
    const c = this.c, s = this.s;
    this.P.push3(this.ox + x * c + z * s, this.oy + y, this.oz - x * s + z * c);
    this.N.push3(nx * c + nz * s, ny, -nx * s + nz * c);
    this.U.push2(u, w);
    this.A.push2(this.p, this.sd);
    return this.nv++;
  }
  tri(i, j, k) { this.I.push1(i); this.I.push1(j); this.I.push1(k); }

  /** Planar quad a→b→c→d (CCW from the front). UVs: metric along (b−a) and (d−a) unless uvs given [u0,v0,…]. */
  quad(a, b, c, d, uvs = null) {
    sub(b, a, _a); sub(d, a, _b); cross(_a, _b, _c); norm(_c);
    let ua, va, ub, vb, uc, vc, ud, vd;
    if (uvs) [ua, va, ub, vb, uc, vc, ud, vd] = uvs;
    else {
      // metric planar UVs: u along the horizontal tangent of the face (or x for flat faces), v along y / z
      const n = _c;
      let tu, tv;
      if (Math.abs(n[1]) > 0.7) { tu = [1, 0, 0]; tv = [0, 0, -Math.sign(n[1]) || -1]; }
      else { tu = norm([n[2], 0, -n[0]]); tv = [0, 1, 0]; }
      ua = dot(a, tu); va = dot(a, tv); ub = dot(b, tu); vb = dot(b, tv);
      uc = dot(c, tu); vc = dot(c, tv); ud = dot(d, tu); vd = dot(d, tv);
    }
    const n = _c;
    const i0 = this.v(a[0], a[1], a[2], n[0], n[1], n[2], ua, va);
    const i1 = this.v(b[0], b[1], b[2], n[0], n[1], n[2], ub, vb);
    const i2 = this.v(c[0], c[1], c[2], n[0], n[1], n[2], uc, vc);
    const i3 = this.v(d[0], d[1], d[2], n[0], n[1], n[2], ud, vd);
    this.tri(i0, i1, i2); this.tri(i0, i2, i3);
    return this;
  }
  /** Triangle a→b→c (CCW from the front), metric UVs. */
  triangle(a, b, c) {
    sub(b, a, _a); sub(c, a, _b); cross(_a, _b, _c); norm(_c);
    const n = _c;
    let tu, tv;
    if (Math.abs(n[1]) > 0.7) { tu = [1, 0, 0]; tv = [0, 0, -1]; } else { tu = norm([n[2], 0, -n[0]]); tv = [0, 1, 0]; }
    const i0 = this.v(a[0], a[1], a[2], n[0], n[1], n[2], dot(a, tu), dot(a, tv));
    const i1 = this.v(b[0], b[1], b[2], n[0], n[1], n[2], dot(b, tu), dot(b, tv));
    const i2 = this.v(c[0], c[1], c[2], n[0], n[1], n[2], dot(c, tu), dot(c, tv));
    this.tri(i0, i1, i2);
    return this;
  }
  face(c, u, v, hu, hv) {
    const a = [c[0] - u[0] * hu - v[0] * hv, c[1] - u[1] * hu - v[1] * hv, c[2] - u[2] * hu - v[2] * hv];
    const b = [c[0] + u[0] * hu - v[0] * hv, c[1] + u[1] * hu - v[1] * hv, c[2] + u[2] * hu - v[2] * hv];
    const cc = [c[0] + u[0] * hu + v[0] * hv, c[1] + u[1] * hu + v[1] * hv, c[2] + u[2] * hu + v[2] * hv];
    const d = [c[0] - u[0] * hu + v[0] * hv, c[1] - u[1] * hu + v[1] * hv, c[2] - u[2] * hu + v[2] * hv];
    // uv: metric along u / v, offset by the centre so neighbouring faces tile continuously
    const cu = dot(c, u), cv = dot(c, v);
    return this.quad(a, b, cc, d, [cu - hu, cv - hv, cu + hu, cv - hv, cu + hu, cv + hv, cu - hu, cv + hv]);
  }
  box(x0, y0, z0, x1, y1, z1, skip = 0) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, hx = Math.abs(x1 - x0) / 2, hy = Math.abs(y1 - y0) / 2, hz = Math.abs(z1 - z0) / 2;
    if (!(skip & FACE.PX)) this.face([cx + hx, cy, cz], [0, 0, -1], [0, 1, 0], hz, hy);
    if (!(skip & FACE.NX)) this.face([cx - hx, cy, cz], [0, 0, 1], [0, 1, 0], hz, hy);
    if (!(skip & FACE.PZ)) this.face([cx, cy, cz + hz], [1, 0, 0], [0, 1, 0], hx, hy);
    if (!(skip & FACE.NZ)) this.face([cx, cy, cz - hz], [-1, 0, 0], [0, 1, 0], hx, hy);
    if (!(skip & FACE.PY)) this.face([cx, cy + hy, cz], [1, 0, 0], [0, 0, -1], hx, hz);
    if (!(skip & FACE.NY)) this.face([cx, cy - hy, cz], [1, 0, 0], [0, 0, 1], hx, hz);
    return this;
  }
  obox(c, ex, ey, ez, hx, hy, hz, skip = 0) {
    const off = (v, k) => [c[0] + v[0] * k, c[1] + v[1] * k, c[2] + v[2] * k];
    const neg = (v) => [-v[0], -v[1], -v[2]];
    if (!(skip & FACE.PX)) this.face(off(ex, hx), neg(ez), ey, hz, hy);
    if (!(skip & FACE.NX)) this.face(off(ex, -hx), ez, ey, hz, hy);
    if (!(skip & FACE.PZ)) this.face(off(ez, hz), ex, ey, hx, hy);
    if (!(skip & FACE.NZ)) this.face(off(ez, -hz), neg(ex), ey, hx, hy);
    if (!(skip & FACE.PY)) this.face(off(ey, hy), ex, neg(ez), hx, hz);
    if (!(skip & FACE.NY)) this.face(off(ey, -hy), ex, ez, hx, hz);
    return this;
  }
  beam(a, b, w, h, up = [0, 1, 0], skip = 0) {
    const d = norm(sub(b, a, [0, 0, 0])), L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let ex = norm(cross(up, d, [0, 0, 0]));
    if (!isFinite(ex[0]) || Math.hypot(...ex) < 0.5) ex = norm(cross([1, 0, 0], d, [0, 0, 0]));
    const ey = norm(cross(d, ex, [0, 0, 0]));
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return this.obox(c, ex, ey, d, w / 2, h / 2, L / 2, skip);
  }
  cyl(x, y, z, r0, r1, h, seg = 10, caps = true) {
    const base = this.nv;
    const circ = Math.PI * (r0 + r1);
    const sl = (r0 - r1) / h;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const nl = 1 / Math.hypot(1, sl);
      this.v(x + ca * r0, y, z + sa * r0, ca * nl, sl * nl, sa * nl, (i / seg) * circ, 0);
      this.v(x + ca * r1, y + h, z + sa * r1, ca * nl, sl * nl, sa * nl, (i / seg) * circ, h);
    }
    for (let i = 0; i < seg; i++) { const k = base + i * 2; this.tri(k, k + 1, k + 3); this.tri(k, k + 3, k + 2); }
    if (caps) {
      const t0 = this.v(x, y + h, z, 0, 1, 0, 0, 0);
      const r = [];
      for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; r.push(this.v(x + Math.cos(a) * r1, y + h, z + Math.sin(a) * r1, 0, 1, 0, Math.cos(a) * r1, Math.sin(a) * r1)); }
      for (let i = 0; i < seg; i++) this.tri(t0, r[i + 1], r[i]);
    }
    return this;
  }
  /** Surface of revolution around local y through (x, y, z); prof = [[r, y], ...] bottom → top. */
  lathe(x, y, z, prof, seg = 10, sx = 1, sy = 1) {
    const base = this.nv, m = prof.length;
    let acc = 0;
    const vs = [0];
    for (let k = 1; k < m; k++) { acc += Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]); vs.push(acc); }
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      for (let k = 0; k < m; k++) {
        const k0 = Math.max(0, k - 1), k1 = Math.min(m - 1, k + 1);
        const dr = prof[k1][0] - prof[k0][0], dy = prof[k1][1] - prof[k0][1];
        const l = Math.hypot(dr, dy) || 1;
        const nr = dy / l, ny = -dr / l;
        this.v(x + ca * prof[k][0] * sx, y + prof[k][1] * sy, z + sa * prof[k][0] * sx, ca * nr, ny, sa * nr, (i / seg) * 2 * Math.PI * 0.3, vs[k]);
      }
    }
    for (let i = 0; i < seg; i++) for (let k = 0; k < m - 1; k++) {
      const a = base + i * m + k, b = a + m;
      this.tri(a, b + 1, b); this.tri(a, a + 1, b + 1);
    }
    return this;
  }
  /** Parametric grid (nu+1)×(nv+1); f(i, j, o) fills o.x,o.y,o.z (local) and o.u,o.v (uv). */
  grid(nu, nv, f, flip = false) {
    const W = nu + 1, H = nv + 1, S = 7, pts = new Float32Array(W * H * S), o = { x: 0, y: 0, z: 0, u: 0, v: 0, p: undefined, s: undefined };
    const p0 = this.p, s0 = this.sd;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      o.p = undefined; o.s = undefined;
      f(i, j, o);
      const k = (j * W + i) * S;
      pts[k] = o.x; pts[k + 1] = o.y; pts[k + 2] = o.z; pts[k + 3] = o.u; pts[k + 4] = o.v; pts[k + 5] = o.p ?? p0; pts[k + 6] = o.s ?? s0;
    }
    const P = (i, j, out) => { const k = (j * W + i) * S; out[0] = pts[k]; out[1] = pts[k + 1]; out[2] = pts[k + 2]; return out; };
    const base = this.nv;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      P(Math.min(i + 1, nu), j, _a); P(Math.max(i - 1, 0), j, _b); sub(_a, _b, _c);
      P(i, Math.min(j + 1, nv), _a); P(i, Math.max(j - 1, 0), _b); sub(_a, _b, _d);
      cross(_c, _d, _a); norm(_a);
      if (flip) { _a[0] = -_a[0]; _a[1] = -_a[1]; _a[2] = -_a[2]; }
      const k = (j * W + i) * S;
      this.p = pts[k + 5]; this.sd = pts[k + 6];
      this.v(pts[k], pts[k + 1], pts[k + 2], _a[0], _a[1], _a[2], pts[k + 3], pts[k + 4]);
    }
    this.p = p0; this.sd = s0;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * W + i, b = a + 1, c = a + W, d = c + 1;
      if (flip) { this.tri(a, c, b); this.tri(b, c, d); } else { this.tri(a, b, c); this.tri(b, d, c); }
    }
    return this;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.P.view(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.N.view(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.U.view(), 2));
    g.setAttribute('aP', new THREE.BufferAttribute(this.A.view(), 2));
    g.setIndex(new THREE.BufferAttribute(this.I.view(), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
