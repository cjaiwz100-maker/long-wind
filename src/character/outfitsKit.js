// Garment construction kit (owner: character C). Pure geometry (no DOM, no GPU) so it runs in a worker.
//
// Garments are authored in BIND space around the body's own anatomical primitives:
//   • shells   — the body regions inflated by the cloth thickness, smooth-unioned with drape primitives (sleeve bags,
//                chest drape, trouser legs) and fold fields, polygonised, clipped along hem/collar/cuff curves
//                (clip-and-snap gives clean edges), given rolled hems and trim bands measured from each open edge.
//   • grids    — parametric surfaces (skirt panels, ribbons, hat) with analytic UVs, skinned to cloth-chain bones.
//   • tubes    — swept circles/ellipses along polylines (cords, hair strands, grips, spear shafts).
// Every mesh carries per-vertex extras: color (linear albedo), color2 (lining/back-face albedo), cloth
// (x translucency, y flutter, z rim, w cavity AO), skinIndex/skinWeight (4 influences, skeleton indices).
import * as THREE from 'three';
import { unionSDF, meshSDF, clipMesh, projectToSDF, addHems, boundaryLoops, adjacency, smoothField, computeNormals, compact, orientFaces } from './humanoidSdf.js';
import { top4 } from './humanoid.js';

export const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mix = (a, b, t) => a + (b - a) * t;

/** Cheap deterministic hash noise (value noise, 3D) for folds and colour mottling. */
function h3(x, y, z) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
export function vnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const a = h3(ix, iy, iz), b = h3(ix + 1, iy, iz), c = h3(ix, iy + 1, iz), d = h3(ix + 1, iy + 1, iz);
  const e = h3(ix, iy, iz + 1), f = h3(ix + 1, iy, iz + 1), g = h3(ix, iy + 1, iz + 1), hh = h3(ix + 1, iy + 1, iz + 1);
  return mix(mix(mix(a, b, ux), mix(c, d, ux), uy), mix(mix(e, f, ux), mix(g, hh, ux), uy), uz);
}

// ---------------------------------------------------------------------------------------------------------------
// SDF helpers
// ---------------------------------------------------------------------------------------------------------------

/** Wrap a primitive: inflate by t metres, optionally override its blend radius k. */
export function inflate(prim, t, k) {
  const d = prim.d;
  return { d: (x, y, z) => d(x, y, z) - t, k: k ?? prim.k ?? 0.02 };
}

/**
 * Garment SDF: smooth union of items minus a displacement field (folds, bulges). Keeps the block-culling API of
 * unionSDF so the polygoniser only evaluates nearby items. `dispMax` bounds |disp| (for culling reach).
 */
export function garmentSDF(items, k = 0.03, disp = null, dispMax = 0.03) {
  const u = unionSDF(items, k);
  if (!disp) return u;
  const f = (x, y, z) => u(x, y, z) - disp(x, y, z);
  f.items = u.items;
  f.relevant = (cx, cy, cz, reach, out) => u.relevant(cx, cy, cz, reach + dispMax, out);
  f.subset = (list, m, x, y, z) => u.subset(list, m, x, y, z) - disp(x, y, z);
  return f;
}

/** Signed distance to a 2D segment-polyline triangle etc. (2D helpers for collar/hem curves). */
export function sdSegment2(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Signed distance from p to a capsule-limited half space: the cut plane (through c, normal n) beyond `along`,
 * restricted to within `radius` of the axis. Positive = cut away. Used for cuffs and trouser ends. */
export function axisCut(x, y, z, c, n, radius) {
  const px = x - c.x, py = y - c.y, pz = z - c.z;
  const al = px * n.x + py * n.y + pz * n.z;
  const rx = px - n.x * al, ry = py - n.y * al, rz = pz - n.z * al;
  return Math.min(al, radius - Math.sqrt(rx * rx + ry * ry + rz * rz));
}

// ---------------------------------------------------------------------------------------------------------------
// shells
// ---------------------------------------------------------------------------------------------------------------

/**
 * Polygonise a garment SDF inside box, clip with clip(x,y,z) (> 0 removed), re-project. Returns a mesh with an
 * empty extra block. `tris` is the decimation target before clipping.
 */
export function shell({ sdf, box, voxel = 0.016, tris = 8000, clip = null }) {
  let m = meshSDF(sdf, box[0], box[1], voxel, tris);
  if (clip) m = clipMesh(m, clip, { snap: true });
  projectToSDF(m, sdf, 1, voxel * 0.25);
  if (clip) m = clipMesh(m, clip, { snap: true }); // tidy anything the projection pushed back over the edge
  m.extra = m.extra || {};
  return m;
}

/**
 * Distance (m, Euclidean to the nearest boundary vertex) from every vertex to the open edges of a mesh, per class.
 * classify(cx, cy, cz, loop) → class name (or null to ignore) for each boundary loop (called with its centroid).
 * Returns { [class]: Float32Array(nv) } (Infinity when the class has no loop).
 */
export function edgeDistances(mesh, classify) {
  const P = mesh.positions, nv = P.length / 3;
  const loops = boundaryLoops(mesh.indices);
  const byClass = {};
  for (const L of loops) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of L.verts) { cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; }
    const n = L.verts.length; cx /= n; cy /= n; cz /= n;
    const c = classify(cx, cy, cz, L);
    if (!c) continue;
    (byClass[c] ||= []).push(...L.verts);
  }
  const out = {};
  for (const c in byClass) {
    const B = byClass[c];
    const bx = new Float32Array(B.length), by = new Float32Array(B.length), bz = new Float32Array(B.length);
    B.forEach((v, i) => { bx[i] = P[v * 3]; by[i] = P[v * 3 + 1]; bz[i] = P[v * 3 + 2]; });
    const d = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      let m = 1e9;
      for (let i = 0; i < B.length; i++) { const dx = x - bx[i], dy = y - by[i], dz = z - bz[i]; const q = dx * dx + dy * dy + dz * dz; if (q < m) m = q; }
      d[v] = Math.sqrt(m);
    }
    out[c] = d;
  }
  return out;
}

/** Fill per-vertex colour extras from functions fn(x,y,z,v) → [r,g,b] (or constants). */
export function paint(mesh, { color, color2, cloth }) {
  const P = mesh.positions, nv = P.length / 3;
  mesh.extra = mesh.extra || {};
  const fill = (key, size, src) => {
    if (!src) return;
    const a = new Float32Array(nv * size);
    for (let v = 0; v < nv; v++) {
      const c = typeof src === 'function' ? src(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], v) : src;
      for (let i = 0; i < size; i++) a[v * size + i] = c[i];
    }
    mesh.extra[key] = { size, array: a };
  };
  fill('color', 3, color);
  fill('color2', 3, color2 ?? (color && (typeof color === 'function' ? (x, y, z, v) => color(x, y, z, v).map(c => c * 0.8) : color.map(c => c * 0.8))));
  fill('cloth', 4, cloth);
  return mesh;
}

/** Rolled hems on open edges (keeps extras). filter(x,y,z) selects loops by a vertex position. */
export function hem(mesh, t = 0.006, back = 0.018, filter = null) {
  const out = addHems(mesh, t, back, filter);
  return out;
}

/**
 * Skin a mesh from a dense weight function over `slots` bones: fn(x, y, z, v, out) fills out (Float32Array(slots)).
 * The field is Laplacian-smoothed over the surface, reduced to 4 influences and mapped to skeleton indices through
 * slotBone (array: slot → skeleton bone index).
 */
export function skinDense(mesh, fn, slotBone, passes = 2) {
  const P = mesh.positions, nv = P.length / 3, S = slotBone.length;
  const dense = new Float32Array(nv * S);
  const tmp = new Float32Array(S);
  for (let v = 0; v < nv; v++) {
    tmp.fill(0);
    fn(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], v, tmp);
    dense.set(tmp, v * S);
  }
  if (passes > 0) smoothField(dense, S, adjacency(nv, mesh.indices), passes, 0.5);
  const si = new Float32Array(nv * 4), sw = new Float32Array(nv * 4);
  for (let v = 0; v < nv; v++) {
    top4(dense.subarray(v * S, (v + 1) * S), si, sw, v * 4);
    for (let i = 0; i < 4; i++) si[v * 4 + i] = slotBone[si[v * 4 + i]];
  }
  mesh.extra = mesh.extra || {};
  mesh.extra.skinIndex = { size: 4, array: si };
  mesh.extra.skinWeight = { size: 4, array: sw };
  return mesh;
}

/** Rigidly bind a whole mesh to one bone. */
export function skinRigid(mesh, bone) {
  const nv = mesh.positions.length / 3;
  const si = new Float32Array(nv * 4), sw = new Float32Array(nv * 4);
  for (let v = 0; v < nv; v++) { si[v * 4] = bone; sw[v * 4] = 1; }
  mesh.extra = mesh.extra || {};
  mesh.extra.skinIndex = { size: 4, array: si };
  mesh.extra.skinWeight = { size: 4, array: sw };
  return mesh;
}

/** Explicit weights: fn(x,y,z,v) → [[bone, w], ...] (≤ 4). */
export function skinExplicit(mesh, fn) {
  const P = mesh.positions, nv = P.length / 3;
  const si = new Float32Array(nv * 4), sw = new Float32Array(nv * 4);
  for (let v = 0; v < nv; v++) {
    const list = fn(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], v);
    let t = 0;
    for (let i = 0; i < Math.min(4, list.length); i++) { si[v * 4 + i] = list[i][0]; sw[v * 4 + i] = list[i][1]; t += list[i][1]; }
    if (t > 0) for (let i = 0; i < 4; i++) sw[v * 4 + i] /= t;
  }
  mesh.extra = mesh.extra || {};
  mesh.extra.skinIndex = { size: 4, array: si };
  mesh.extra.skinWeight = { size: 4, array: sw };
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------
// parametric surfaces
// ---------------------------------------------------------------------------------------------------------------

/**
 * Tube along a polyline of points [[x,y,z]...] with radius(t) (t ∈ [0,1] along the length) and an optional
 * elliptical squash (flat: y/x ratio of the cross-section, with `up` reference). Capped ends optional.
 * Returns mesh with uv (u around, v along length in metres).
 */
export function tube(points, radius, { sides = 8, flat = 1, up = [0, 1, 0], caps = true, twist = 0, samples = 0 } = {}) {
  // optional resampling with Catmull-Rom for smooth curves
  let pts = points.map(p => V(...p));
  if (samples > pts.length) pts = catmull(pts, samples);
  const n = pts.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const L = cum[n - 1] || 1;
  // rotation-minimising frames
  const T = [], Nn = [], B = [];
  for (let i = 0; i < n; i++) T.push(pts[Math.min(i + 1, n - 1)].clone().sub(pts[Math.max(i - 1, 0)]).normalize());
  let nrm = V(...up).cross(T[0]); if (nrm.lengthSq() < 1e-6) nrm = V(1, 0, 0).cross(T[0]); nrm.normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) { const q = new THREE.Quaternion().setFromUnitVectors(T[i - 1], T[i]); nrm = nrm.clone().applyQuaternion(q); }
    Nn.push(nrm.clone()); B.push(T[i].clone().cross(nrm).normalize());
  }
  const P = [], NN = [], UV = [], I = [];
  for (let i = 0; i < n; i++) {
    const t = cum[i] / L, r = typeof radius === 'function' ? radius(t) : radius;
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2 + twist * t;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = Nn[i].x * ca + B[i].x * sa * flat, ny = Nn[i].y * ca + B[i].y * sa * flat, nz = Nn[i].z * ca + B[i].z * sa * flat;
      P.push(pts[i].x + nx * r, pts[i].y + ny * r, pts[i].z + nz * r);
      const gx = Nn[i].x * ca * flat + B[i].x * sa, gy = Nn[i].y * ca * flat + B[i].y * sa, gz = Nn[i].z * ca * flat + B[i].z * sa;
      const gl = Math.hypot(gx, gy, gz) || 1;
      NN.push(gx / gl, gy / gl, gz / gl);
      UV.push(s / sides, cum[i]);
    }
  }
  const row = sides + 1;
  for (let i = 0; i < n - 1; i++) for (let s = 0; s < sides; s++) {
    const a = i * row + s, b = a + 1, c = a + row + 1, d = a + row;
    I.push(a, d, c, a, c, b);
  }
  if (caps) {
    for (const [i, dir] of [[0, -1], [n - 1, 1]]) {
      const c = P.length / 3;
      const r = typeof radius === 'function' ? radius(i === 0 ? 0 : 1) : radius;
      if (r < 1e-4) continue;
      P.push(pts[i].x, pts[i].y, pts[i].z); NN.push(T[i].x * dir, T[i].y * dir, T[i].z * dir); UV.push(0.5, cum[i]);
      for (let s = 0; s < sides; s++) {
        const a = i * row + s, b = a + 1;
        if (dir > 0) I.push(c, a, b); else I.push(c, b, a);
      }
    }
  }
  const out = { positions: new Float32Array(P), normals: new Float32Array(NN), indices: new Uint32Array(I), uvs: new Float32Array(UV), extra: {}, frames: { pts, T, N: Nn, B, cum } };
  orientFaces(out.positions, out.normals, out.indices);
  return out;
}

/** Uniform Catmull-Rom resampling of a polyline to m points (by parameter, not arc length). */
export function catmull(pts, m) {
  const n = pts.length, out = [];
  for (let k = 0; k < m; k++) {
    const f = k / (m - 1) * (n - 1);
    const i = Math.min(Math.floor(f), n - 2), t = f - i;
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n - 1)];
    const t2 = t * t, t3 = t2 * t;
    out.push(new THREE.Vector3(
      0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3)));
  }
  return out;
}

/**
 * Lathe around +Y: profile [[r, y], ...] from the axis outward (or any order), segs around. uv: u = angle/2π·uRep,
 * v = profile arc length. Normals from the profile (smooth).
 */
export function lathe(profile, segs, { uRep = 1, flip = false } = {}) {
  const n = profile.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const P = [], N = [], UV = [], I = [];
  for (let i = 0; i < n; i++) {
    const [r, y] = profile[i];
    const a = profile[Math.max(i - 1, 0)], b = profile[Math.min(i + 1, n - 1)];
    let tr = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tr, ty) || 1; tr /= tl; ty /= tl;
    // outward normal of the profile (rotate tangent by −90° in (r,y))
    let nr = ty, ny = -tr;
    if (flip) { nr = -nr; ny = -ny; }
    for (let s = 0; s <= segs; s++) {
      const ang = s / segs * Math.PI * 2, c = Math.cos(ang), sn = Math.sin(ang);
      P.push(r * sn, y, r * c); N.push(nr * sn, ny, nr * c); UV.push(s / segs * uRep, cum[i]);
    }
  }
  const row = segs + 1;
  for (let i = 0; i < n - 1; i++) for (let s = 0; s < segs; s++) {
    const a = i * row + s, b = a + 1, c = a + row + 1, d = a + row;
    if (flip) I.push(a, b, c, a, c, d); else I.push(a, c, b, a, d, c);
  }
  const out = { positions: new Float32Array(P), normals: new Float32Array(N), indices: new Uint32Array(I), uvs: new Float32Array(UV), extra: {} };
  orientFaces(out.positions, out.normals, out.indices);
  return out;
}

/** Merge meshes that share the same extras layout (keeps uvs when all have them). */
export function merge(list) {
  list = list.filter(Boolean);
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.positions.length / 3; ni += m.indices.length; }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), I = new Uint32Array(ni);
  const hasUV = list.every(m => m.uvs);
  const UV = hasUV ? new Float32Array(nv * 2) : null;
  const keys = Object.keys(list[0]?.extra || {}).filter(k => list.every(m => m.extra?.[k]));
  const ex = {};
  for (const k of keys) ex[k] = { size: list[0].extra[k].size, array: new Float32Array(nv * list[0].extra[k].size) };
  let vo = 0, io = 0;
  for (const m of list) {
    const n = m.positions.length / 3;
    P.set(m.positions, vo * 3); N.set(m.normals, vo * 3);
    if (hasUV) UV.set(m.uvs, vo * 2);
    for (const k of keys) ex[k].array.set(m.extra[k].array, vo * ex[k].size);
    for (let i = 0; i < m.indices.length; i++) I[io + i] = m.indices[i] + vo;
    vo += n; io += m.indices.length;
  }
  const out = { positions: P, normals: N, indices: I, extra: ex };
  if (hasUV) out.uvs = UV;
  return out;
}

/** Apply a Matrix4 to a mesh in place (positions + normals). */
export function xform(mesh, m) {
  const P = mesh.positions, N = mesh.normals, e = m.elements;
  const nm = new THREE.Matrix3().getNormalMatrix(m).elements;
  for (let v = 0; v < P.length; v += 3) {
    const x = P[v], y = P[v + 1], z = P[v + 2];
    P[v] = e[0] * x + e[4] * y + e[8] * z + e[12]; P[v + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; P[v + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const a = N[v], b = N[v + 1], c = N[v + 2];
    const nx = nm[0] * a + nm[3] * b + nm[6] * c, ny = nm[1] * a + nm[4] * b + nm[7] * c, nz = nm[2] * a + nm[5] * b + nm[8] * c;
    const l = Math.hypot(nx, ny, nz) || 1;
    N[v] = nx / l; N[v + 1] = ny / l; N[v + 2] = nz / l;
  }
  if (m.determinant() < 0) { const I = mesh.indices; for (let t = 0; t < I.length; t += 3) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; } }
  return mesh;
}

export { computeNormals, compact };

/** Signed distance to a convex 2D polygon [[x,y]...] (negative inside). */
export function sdPoly2(px, py, pts) {
  let d = 1e9, sgn = 0, inside = true;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    d = Math.min(d, sdSegment2(px, py, a[0], a[1], b[0], b[1]));
    const c = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    const s = c >= 0 ? 1 : -1;
    if (sgn === 0) sgn = s; else if (s !== sgn) inside = false;
  }
  return inside ? -d : d;
}

/**
 * Ambient occlusion baked from an SDF along each vertex normal (5 taps up to `dist`). Returns Float32Array(nv) in
 * [floor, 1]. Folds, armpits, the crotch and the underside of the collar darken; open surfaces stay 1.
 */
export function sdfAO(mesh, sdf, { dist = 0.05, taps = 5, strength = 1.6, floor = 0.35 } = {}) {
  const P = mesh.positions, N = mesh.normals, nv = P.length / 3;
  const out = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
    let occ = 0, wsum = 0, w = 1;
    for (let i = 1; i <= taps; i++) {
      const h = dist * i / taps;
      const d = sdf(x + nx * h, y + ny * h, z + nz * h);
      occ += w * Math.max(0, h - d) / h; wsum += w; w *= 0.7;
    }
    out[v] = Math.max(floor, 1 - strength * occ / wsum);
  }
  return out;
}

/**
 * Sewn-on edge band (collar 领缘, cuffs, hems): a separate strip that follows an open edge of a garment shell,
 * `width` wide on the outside, raised a few mm and rolled over the edge. Crisp where a painted band would be
 * blurred by large triangles. Per-vertex extras (skin weights) are copied from the edge vertex.
 * o = { filter(cx,cy,cz) → bool (per loop centroid), width, color, color2, raise, roll, sdf (to project the inner
 *       edge onto the garment surface), widthFn(x,y,z) (optional per-point width) }
 */
export function trimBand(mesh, o) {
  const P = mesh.positions, N = mesh.normals;
  const loops = boundaryLoops(mesh.indices);
  const out = [];
  const raise = o.raise ?? 0.0022, roll = o.roll ?? 0.005;
  const ex = mesh.extra || {};
  for (const L of loops) {
    const n = L.verts.length;
    if (n < 4) continue;
    let cx = 0, cy = 0, cz = 0;
    for (const v of L.verts) { cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; }
    if (o.filter && !o.filter(cx / n, cy / n, cz / n)) continue;
    // outward in-surface direction per loop vertex (away from the triangle interior), smoothed along the loop
    const E = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = L.verts[i], w = L.verts[(i + 1) % n], x = L.opp[i];
      const ex_ = P[w * 3] - P[v * 3], ey = P[w * 3 + 1] - P[v * 3 + 1], ez = P[w * 3 + 2] - P[v * 3 + 2];
      const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      let ox = ey * nz - ez * ny, oy = ez * nx - ex_ * nz, oz = ex_ * ny - ey * nx;
      const mx = (P[v * 3] + P[w * 3]) * 0.5 - P[x * 3], my = (P[v * 3 + 1] + P[w * 3 + 1]) * 0.5 - P[x * 3 + 1], mz = (P[v * 3 + 2] + P[w * 3 + 2]) * 0.5 - P[x * 3 + 2];
      if (ox * mx + oy * my + oz * mz < 0) { ox = -ox; oy = -oy; oz = -oz; }
      const l = Math.hypot(ox, oy, oz) || 1;
      for (const j of [i, (i + 1) % n]) { E[j * 3] += ox / l; E[j * 3 + 1] += oy / l; E[j * 3 + 2] += oz / l; }
    }
    for (let pass = 0; pass < 3; pass++) {
      const T = E.slice();
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) E[i * 3 + c] = (T[((i + n - 1) % n) * 3 + c] + 2 * T[i * 3 + c] + T[((i + 1) % n) * 3 + c]) / 4;
    }
    const pos = [], nor = [], idx = [], src = [];
    for (let i = 0; i < n; i++) {
      const v = L.verts[i];
      let ex0 = E[i * 3], ey0 = E[i * 3 + 1], ez0 = E[i * 3 + 2];
      const el = Math.hypot(ex0, ey0, ez0) || 1; ex0 /= el; ey0 /= el; ez0 /= el;
      const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2], nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      const w = o.widthFn ? o.widthFn(px, py, pz) : o.width;
      // inner edge: walk back over the surface, re-project onto the garment SDF
      let qx = px - ex0 * w, qy = py - ey0 * w, qz = pz - ez0 * w;
      let qnx = nx, qny = ny, qnz = nz;
      if (o.sdf) for (let it = 0; it < 3; it++) {
        const d = o.sdf(qx, qy, qz), e = 0.0015;
        const gx = o.sdf(qx + e, qy, qz) - o.sdf(qx - e, qy, qz), gy = o.sdf(qx, qy + e, qz) - o.sdf(qx, qy - e, qz), gz = o.sdf(qx, qy, qz + e) - o.sdf(qx, qy, qz - e);
        const gl = Math.hypot(gx, gy, gz) || 1; qnx = gx / gl; qny = gy / gl; qnz = gz / gl;
        qx -= qnx * d; qy -= qny * d; qz -= qnz * d;
      }
      // 5 rings: inner (on the surface), inner raised, outer raised, outer edge, rolled under
      pos.push(qx + qnx * 0.0003, qy + qny * 0.0003, qz + qnz * 0.0003); nor.push(qnx, qny, qnz);
      pos.push(qx + qnx * raise, qy + qny * raise, qz + qnz * raise); nor.push(qnx * 0.6 - ex0 * 0.8, qny * 0.6 - ey0 * 0.8, qnz * 0.6 - ez0 * 0.8);
      pos.push(px + nx * raise + ex0 * 0.001, py + ny * raise + ey0 * 0.001, pz + nz * raise + ez0 * 0.001); nor.push(nx, ny, nz);
      pos.push(px + ex0 * (roll * 0.55) + nx * raise * 0.3, py + ey0 * (roll * 0.55) + ny * raise * 0.3, pz + ez0 * (roll * 0.55) + nz * raise * 0.3); nor.push(ex0, ey0, ez0);
      pos.push(px - nx * roll * 0.8, py - ny * roll * 0.8, pz - nz * roll * 0.8); nor.push(-nx * 0.5 + ex0 * 0.2, -ny * 0.5 + ey0 * 0.2, -nz * 0.5 + ez0 * 0.2);
      for (let k = 0; k < 5; k++) src.push(v);
    }
    const R = 5;
    const segs = L.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      for (let k = 0; k < R - 1; k++) {
        const a = i * R + k, b = j * R + k, c = j * R + k + 1, d = i * R + k + 1;
        idx.push(a, b, c, a, c, d);
      }
    }
    const m = { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx), extra: {} };
    for (let v = 0; v < m.normals.length; v += 3) { const l = Math.hypot(m.normals[v], m.normals[v + 1], m.normals[v + 2]) || 1; m.normals[v] /= l; m.normals[v + 1] /= l; m.normals[v + 2] /= l; }
    orientFaces(m.positions, m.normals, m.indices);
    for (const k of ['skinIndex', 'skinWeight', 'cloth']) if (ex[k]) {
      const sz = ex[k].size, a = new Float32Array(src.length * sz);
      src.forEach((v, i) => { for (let c = 0; c < sz; c++) a[i * sz + c] = ex[k].array[v * sz + c]; });
      m.extra[k] = { size: sz, array: a };
    }
    const nv = src.length;
    const col = new Float32Array(nv * 3), col2 = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
      const c = typeof o.color === 'function' ? o.color(x, y, z) : o.color;
      col.set(c, i * 3); col2.set(o.color2 ?? c.map(q => q * 0.8), i * 3);
    }
    m.extra.color = { size: 3, array: col };
    m.extra.color2 = { size: 3, array: col2 };
    if (m.extra.cloth) for (let i = 0; i < nv; i++) { m.extra.cloth.array[i * 4] *= 0.5; m.extra.cloth.array[i * 4 + 3] = Math.min(1, m.extra.cloth.array[i * 4 + 3] + 0.1); }
    out.push(m);
  }
  return out.length ? merge(out) : null;
}
