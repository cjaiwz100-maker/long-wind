// Small geometry kit for the world props: metric-UV boxes/cylinders, oriented beams, merging with a per-part
// float attribute. Owner: world (W). Every helper returns a NON-indexed BufferGeometry with position / normal / uv
// (+ optional 'aPart'), so heterogeneous parts merge into one draw call per material.
//
//   box(sx, sy, sz, { part })                 centred box, UVs in metres (per-face planar)
//   cyl(r0, r1, h, seg, { part })             y-axis cylinder (r0 bottom, r1 top), base at y = 0, UV (arc m, height m)
//   between(geo, a, b, up?)                   orient a +z-long part from point a to b (its length must be |b−a|)
//   place(geo, { pos, rotY, rotX, rotZ, scale })   in-place transform, returns geo
//   partAttr(geo, v)                          set the 'aPart' attribute to a constant
//   merge(list)                               mergeGeometries (drops attributes not shared by every part)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

export function partAttr(geo, v = 0) {
  const n = geo.getAttribute('position').count;
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(v), 1));
  return geo;
}

/** Planar metric UVs from local positions, projected along each vertex normal's dominant axis. */
export function metricUV(geo, scale = 1) {
  const P = geo.getAttribute('position'), N = geo.getAttribute('normal');
  const uv = new Float32Array(P.count * 2);
  for (let i = 0; i < P.count; i++) {
    const ax = Math.abs(N.getX(i)), ay = Math.abs(N.getY(i)), az = Math.abs(N.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = P.getX(i); v = P.getZ(i); }
    else if (ax >= az) { u = P.getZ(i); v = P.getY(i); }
    else { u = P.getX(i); v = P.getY(i); }
    uv[i * 2] = u * scale; uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

export function box(sx, sy, sz, { part = 0, uvScale = 1 } = {}) {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  metricUV(g, uvScale);
  return partAttr(g, part);
}

export function cyl(r0, r1, h, seg = 12, { part = 0, cap = true } = {}) {
  const g0 = new THREE.CylinderGeometry(r1, r0, h, seg, 1, !cap);
  g0.translate(0, h / 2, 0);
  const g = g0.toNonIndexed();
  const uv = g.getAttribute('uv'), N = g.getAttribute('normal'), P = g.getAttribute('position');
  const circ = Math.PI * (r0 + r1);
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(N.getY(i)) > 0.9) uv.setXY(i, P.getX(i), P.getZ(i));
    else uv.setXY(i, uv.getX(i) * circ, P.getY(i));
  }
  return partAttr(g, part);
}

/** Orient a part built along +z (centred, length L) so it spans a → b. */
export function between(geo, a, b, roll = 0) {
  const d = _v.subVectors(b, a), L = d.length();
  _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().divideScalar(L));
  if (roll) _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  _m.compose(_s.addVectors(a, b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(_m);
  return geo;
}

export function beam(a, b, w, h, opts = {}) {
  const L = a.distanceTo(b);
  return between(box(w, h, L, opts), a, b, opts.roll || 0);
}

export function place(geo, { pos = [0, 0, 0], rotX = 0, rotY = 0, rotZ = 0, scale = 1 } = {}) {
  _e.set(rotX, rotY, rotZ, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(new THREE.Vector3(...pos), _q, typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3(...scale));
  geo.applyMatrix4(_m);
  return geo;
}

export function merge(list) {
  const parts = list.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
  if (!parts.length) return null;
  const names = Object.keys(parts[0].attributes).filter((k) => parts.every((g) => g.getAttribute(k)));
  for (const g of parts) for (const k of Object.keys(g.attributes)) if (!names.includes(k)) g.deleteAttribute(k);
  const out = mergeGeometries(parts, false);
  out.computeBoundingSphere();
  return out;
}
