// Gameplay math helpers: easing, frame-rate independent damping, angles, and the segment/capsule geometry used by
// hit detection. Owner: gameplay (P). Everything here is allocation-free and DOM-free (node tests import it).
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) { const t = saturate((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }
export function smootherstep(e0, e1, x) { const t = saturate((x - e0) / (e1 - e0)); return t * t * t * (t * (t * 6 - 15) + 10); }
export const easeOutCubic = (t) => 1 - Math.pow(1 - saturate(t), 3);
export const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * saturate(t));

/** Frame-rate independent exponential approach factor `1 − exp(−rate·dt)` (bible §7.5). */
export const expK = (rate, dt) => 1 - Math.exp(-rate * dt);
export const damp = (a, b, rate, dt) => a + (b - a) * expK(rate, dt);

/** Wrap to (−π, π]. */
export function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
export const dampAngle = (a, b, rate, dt) => a + wrapAngle(b - a) * expK(rate, dt);
/** Move angle `a` toward `b` by at most `maxStep` radians. */
export function stepAngle(a, b, maxStep) { const d = wrapAngle(b - a); return a + clamp(d, -maxStep, maxStep); }

/** Yaw that faces world direction (x, z). Contract: yaw 0 faces +Z, yaw π faces −Z. */
export const yawOf = (x, z) => Math.atan2(x, z);

/** World XZ direction → character-local (x = local +X = character LEFT, y = local +Z = forward). */
export function toLocal(wx, wz, yaw, out) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = wx * c - wz * s;
  out.y = wx * s + wz * c;
  return out;
}
/** Character-local (lx = left, lz = forward) → world XZ written into out.x / out.z (Vector3) or out.x/out.y (Vector2). */
export function toWorld(lx, lz, yaw, out) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const x = lx * c + lz * s, z = -lx * s + lz * c;
  if (out.isVector3) { out.x = x; out.z = z; } else { out.x = x; out.y = z; }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Segment geometry (Ericson, Real-Time Collision Detection §5.1.9), scalar math, no allocations.
const EPS = 1e-9;
const _r = { s: 0, t: 0 };

/**
 * Closest points between segments p1–q1 and p2–q2. Writes them into c1 / c2 (optional) and returns the squared
 * distance. `_r.s` / `_r.t` hold the segment parameters of the closest points afterwards (see lastParams()).
 */
export function closestSegSeg(p1, q1, p2, q2, c1, c2) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = saturate(f / e); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = saturate(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? saturate((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = saturate(-c / a); }
      else if (t > 1) { t = 1; s = saturate((b - c) / a); }
    }
  }
  const ax = p1.x + d1x * s, ay = p1.y + d1y * s, az = p1.z + d1z * s;
  const bx = p2.x + d2x * t, by = p2.y + d2y * t, bz = p2.z + d2z * t;
  if (c1) c1.set(ax, ay, az);
  if (c2) c2.set(bx, by, bz);
  _r.s = s; _r.t = t;
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}
export const lastParams = () => _r;

/** Squared distance from point p to segment a–b. */
export function pointSegDist2(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > EPS ? saturate((apx * abx + apy * aby + apz * abz) / l2) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _C1 = new THREE.Vector3(), _C2 = new THREE.Vector3();

/**
 * Swept blade (segment base0→tip0 moving to base1→tip1 during one frame) vs a list of hurt capsules
 * [{a, b, r, part}]. The sweep is sub-sampled so fast swings cannot tunnel: the number of sub-steps follows the tip
 * travel (≤ 12 cm per step), and the tip path itself is also tested. Returns the first contact (smallest sweep
 * fraction), or null. `out` receives { s, index, part, point (Vector3), depth }.
 */
export function sweepBladeVsCapsules(base0, tip0, base1, tip1, caps, bladeR, out) {
  const travel = Math.max(tip0.distanceTo(tip1), base0.distanceTo(base1));
  const steps = clamp(Math.ceil(travel / 0.12), 1, 10);
  let best = -1, bestS = 2, bestD = Infinity;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    _A.lerpVectors(base0, base1, s);
    _B.lerpVectors(tip0, tip1, s);
    for (let k = 0; k < caps.length; k++) {
      const c = caps[k];
      const R = c.r + bladeR;
      const d2 = closestSegSeg(_A, _B, c.a, c.b, _C1, _C2);
      if (d2 < R * R && (s < bestS || (s === bestS && d2 < bestD))) {
        best = k; bestS = s; bestD = d2;
        out.point.copy(_C1).lerp(_C2, 0.5);
      }
    }
    if (best >= 0) break; // earliest sub-step with a contact wins
  }
  if (best < 0) {
    // the tip path (arc chord) catches very thin/fast contacts between sub-steps
    for (let k = 0; k < caps.length; k++) {
      const c = caps[k];
      const R = c.r + bladeR * 0.5;
      const d2 = closestSegSeg(tip0, tip1, c.a, c.b, _C1, _C2);
      if (d2 < R * R && d2 < bestD) { best = k; bestD = d2; bestS = _r.s; out.point.copy(_C1).lerp(_C2, 0.5); }
    }
  }
  if (best < 0) return null;
  out.s = bestS; out.index = best; out.part = caps[best].part; out.depth = caps[best].r + bladeR - Math.sqrt(bestD);
  return out;
}

/** Tiny seeded RNG wrapper with helpers (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length) % arr.length],
    sign: () => (next() < 0.5 ? -1 : 1),
  };
}

/** Squared distance between segments p0–p1 and q0–q1 (THREE.Vector3). */
export function segSegDist2(p0, p1, q0, q1) {
  const ux = p1.x - p0.x, uy = p1.y - p0.y, uz = p1.z - p0.z;
  const vx = q1.x - q0.x, vy = q1.y - q0.y, vz = q1.z - q0.z;
  const wx = p0.x - q0.x, wy = p0.y - q0.y, wz = p0.z - q0.z;
  const a = ux * ux + uy * uy + uz * uz, b = ux * vx + uy * vy + uz * vz, c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz, e = vx * wx + vy * wy + vz * wz;
  const D = a * c - b * b;
  let sN, sD = D, tN, tD = D;
  if (D < 1e-9) { sN = 0; sD = 1; tN = e; tD = c; }
  else {
    sN = b * e - c * d; tN = a * e - b * d;
    if (sN < 0) { sN = 0; tN = e; tD = c; } else if (sN > sD) { sN = sD; tN = e + b; tD = c; }
  }
  if (tN < 0) { tN = 0; sN = -d < 0 ? 0 : -d > a ? sD : -d; sD = -d < 0 || -d > a ? sD : a; }
  else if (tN > tD) { tN = tD; const k = -d + b; sN = k < 0 ? 0 : k > a ? sD : k; sD = k < 0 || k > a ? sD : a; }
  const sc = Math.abs(sN) < 1e-9 ? 0 : sN / sD, tc = Math.abs(tN) < 1e-9 ? 0 : tN / tD;
  const dx = wx + sc * ux - tc * vx, dy = wy + sc * uy - tc * vy, dz = wz + sc * uz - tc * vz;
  return dx * dx + dy * dy + dz * dz;
}
