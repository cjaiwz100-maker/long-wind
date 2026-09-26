// Procedural human body (owner: character C): bind rig, skin-weight field, SDF body / head / hands.
//
// Everything is authored in BIND space: the fixed contract skeleton (skeleton.js, T-pose rest with identity rotations)
// posed into a relaxed A-pose (arms ~47° down, elbows slightly bent). Binding in an A-pose means the most common
// poses (arms down, guard, strikes) are close to bind and deform far better than from a T-pose. The inverse bind
// matrices simply come from this posed rig; the animator still sees identity-rest bones.
//
// Body surfaces are smooth unions of anatomical primitives (ribcage, pecs, deltoids, biceps, quads, calves, …)
// polygonised with surface nets, so there are no loft seams at shoulders or hips. Skin weights come from one
// analytic field (weightsAt) shared by the body and every garment: region soft-min (torso / arms / legs / neck)
// then smooth blends along each bone chain, then Laplacian smoothing on the mesh.
import * as THREE from 'three';
import { BONE_DEFS, createSkeleton } from './skeleton.js';
import { roundCone, ellipsoid, roundBox, unionSDF, meshSDF, MESH_LOD, clipMesh, projectToSDF, adjacency, smoothField, transformMesh } from './humanoidSdf.js';

export const BONE_NAMES = BONE_DEFS.map(d => d[0]);
export const BONE_INDEX = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------------------------------------------
// bind rig
// ---------------------------------------------------------------------------------------------------------------

/** Rest skeleton posed into the bind A-pose. Returns joint positions/matrices in bind (character) space. */
export function makeBindRig(scale = 1) {
  const rig = createSkeleton(scale);
  const B = rig.bones;
  const armDirL = V(0.68, -0.73, 0.08).normalize();
  B['upperArm.L'].quaternion.setFromUnitVectors(V(1, 0, 0), armDirL);
  B['upperArm.R'].quaternion.setFromUnitVectors(V(-1, 0, 0), V(-armDirL.x, armDirL.y, armDirL.z));
  B['lowerArm.L'].quaternion.setFromAxisAngle(V(0, 1, 0), -0.2);
  B['lowerArm.R'].quaternion.setFromAxisAngle(V(0, 1, 0), 0.2);
  rig.root.updateMatrixWorld(true);
  const M = {}, J = {}, Q = {};
  for (const n of BONE_NAMES) {
    M[n] = B[n].matrixWorld.clone();
    J[n] = V(0, 0, 0).setFromMatrixPosition(M[n]);
    Q[n] = new THREE.Quaternion().setFromRotationMatrix(M[n]);
  }
  const inverses = rig.list.map(b => b.matrixWorld.clone().invert());
  /** point given in a bone's local frame (rest axes: x left, y up, z fwd) → bind space */
  const P = (bone, x, y, z) => V(x, y, z).multiplyScalar(1).applyMatrix4(M[bone]);
  return { scale, M, J, Q, inverses, P };
}

// ---------------------------------------------------------------------------------------------------------------
// builds
// ---------------------------------------------------------------------------------------------------------------

/**
 * Body build parameters. girth/arm/leg are radius multipliers; mus = muscle definition (0..1.5); belly 0..1.
 * skin = linear albedo.
 */
export function bodyBuild(kind, rng = Math.random) {
  const r = (a, b) => a + (b - a) * rng();
  switch (kind) {
    // skin: sun-weathered East Asian (bible §1.4, slightly desaturated so the golden key light doesn't push it to clay)
    case 'hero': return { scale: 1.0, shoulder: 1.05, girth: 0.95, waist: 0.86, arm: 0.93, leg: 0.95, mus: 0.9, belly: 0, neck: 0.95, skin: [0.31, 0.2, 0.148], stubble: 0.12 };
    case 'assassin': return { scale: 0.98, shoulder: 0.98, girth: 0.86, waist: 0.82, arm: 0.9, leg: 0.97, mus: 0.85, belly: 0, neck: 0.9, skin: [0.26, 0.17, 0.13], stubble: 0.05 };
    case 'swordmaster': return { scale: 1.02, shoulder: 1.04, girth: 0.95, waist: 0.88, arm: 0.95, leg: 0.95, mus: 0.9, belly: 0, neck: 0.95, skin: [0.25, 0.165, 0.125], stubble: 0.1 };
    // broad and powerful, not fat: wide shoulders and lats, thick neck and arms, a solid (not soft) midsection
    // townsfolk (world/citizens.js): ordinary builds, softer muscle; the child is a small frame. citizen_s (scholar)
    // shares citizen_m's build (same kind-name length → same face seed → one cached body for both)
    case 'citizen_m': case 'citizen_s': return { scale: 0.98, shoulder: 1.0, girth: 1.0, waist: 0.95, arm: 0.95, leg: 0.97, mus: 0.7, belly: 0.1, neck: 1.0, skin: [0.25, 0.163, 0.118], stubble: 0.45 };
    case 'citizen_f': return { scale: 0.93, shoulder: 0.88, girth: 0.86, waist: 0.8, arm: 0.82, leg: 0.93, mus: 0.25, belly: 0, neck: 0.84, skin: [0.32, 0.21, 0.16], stubble: 0 };
    case 'citizen_old': return { scale: 0.95, shoulder: 0.95, girth: 0.96, waist: 1.0, arm: 0.88, leg: 0.9, mus: 0.35, belly: 0.3, neck: 0.95, skin: [0.235, 0.152, 0.112], stubble: 0.55 };
    case 'citizen_child': return { scale: 0.7, shoulder: 0.9, girth: 0.92, waist: 0.94, arm: 0.86, leg: 0.9, mus: 0.15, belly: 0.1, neck: 0.9, skin: [0.32, 0.21, 0.16], stubble: 0 };
    case 'bandit_heavy': return { scale: 1.08, shoulder: 1.2, girth: 1.17, waist: 1.04, arm: 1.3, leg: 1.16, mus: 1.45, belly: 0.18, neck: 1.28, skin: [0.235, 0.152, 0.108], stubble: 0.35, abs: 1 };
    default: {
      const b = rng();
      const tone = r(0.2, 0.28);
      return {
        scale: r(0.96, 1.03), shoulder: r(0.99, 1.1), girth: r(0.95, 1.12), waist: r(0.88, 1.1), arm: r(0.95, 1.15), leg: r(0.95, 1.1),
        mus: r(0.8, 1.25), belly: b > 0.75 ? r(0.15, 0.4) : 0, neck: r(1.0, 1.15), skin: [tone, tone * r(0.63, 0.68), tone * r(0.46, 0.5)], stubble: r(0.35, 1.0),
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// body primitives
// ---------------------------------------------------------------------------------------------------------------

/**
 * Anatomical primitives grouped by region, in bind space. Left-side limb parts are authored in bone-local coords
 * and mirrored (x → −x) for the right side (right bones point −X at rest).
 */
function bodyPrimitives(bind, b) {
  const { J, P, Q } = bind;
  const s = bind.scale, g = b.girth * s, w = b.waist * s, m = b.mus;
  const hy = J.hips.y, sy = J.spine.y, cy = J.chest.y, ny = J.neck.y;
  const torso = [];
  const add = (arr, prim, k, tag) => { prim.k = k; prim.tag = tag; arr.push(prim); return prim; };
  // torso — heights relative to the joints so scaled skeletons stay proportional
  add(torso, ellipsoid(V(0, cy + 0.06 * s, -0.012 * s), V(0.148 * g * b.shoulder, 0.19 * s, 0.108 * g)), 0.0, 'chest');
  add(torso, ellipsoid(V(0, sy + 0.035 * s, 0.004 * s), V(0.128 * w, 0.13 * s, 0.098 * w)), 0.06, 'waist');
  if (b.belly > 0) add(torso, ellipsoid(V(0, sy + 0.01 * s, 0.035 * s * b.belly), V(0.14 * w, 0.14 * s, (0.1 + 0.05 * b.belly) * w)), 0.08, 'belly');
  add(torso, ellipsoid(V(0, hy - 0.03 * s, -0.01 * s), V(0.152 * w * 0.98, 0.11 * s, 0.104 * w)), 0.07, 'pelvis');
  for (const sx of [1, -1]) {
    add(torso, ellipsoid(V(sx * 0.066 * g, cy + 0.085 * s, 0.062 * g), V(0.074 * g, 0.056 * s * (0.85 + 0.15 * m), 0.034 * g * (0.8 + 0.3 * m))), 0.045, 'pec'); // pec
    add(torso, ellipsoid(V(sx * 0.098 * g, cy + 0.02 * s, -0.035 * g), V(0.055 * g, 0.115 * s, 0.07 * g)), 0.05, 'lat'); // lat
    add(torso, ellipsoid(V(sx * 0.066 * w, hy - 0.08 * s, -0.052 * w), V(0.074 * w, 0.085 * s, 0.066 * w)), 0.05, 'glute'); // glute
    add(torso, roundCone(V(sx * 0.035 * s, ny - 0.02 * s, -0.03 * s), V(sx * 0.155 * g * b.shoulder, ny - 0.07 * s, -0.025 * s), 0.052 * b.neck * s, 0.045 * g), 0.05, 'trap'); // trapezius slope
  }
  add(torso, ellipsoid(V(0, cy + 0.16 * s, -0.045 * s), V(0.1 * g, 0.07 * s, 0.07 * g)), 0.05, 'upperback'); // upper back mass
  if (b.abs) {
    // rectus abdominis blocks + obliques: a hard, blocky midsection that reads as strength (bare-chested builds)
    // front surface z of the torso ellipsoids at (x, y)
    const front = (x, y) => {
      let z = -1;
      for (const p of torso) {
        if (!['chest', 'waist', 'belly'].includes(p.tag) || !p.c || !p.r) continue;
        const u = 1 - ((x - p.c.x) / p.r.x) ** 2 - ((y - p.c.y) / p.r.y) ** 2;
        if (u > 0) z = Math.max(z, p.c.z + p.r.z * Math.sqrt(u));
      }
      return z;
    };
    for (const [yy, rw] of [[cy - 0.03 * s, 0.033], [sy + 0.07 * s, 0.032], [sy + 0.0 * s, 0.03]]) {
      for (const sx of [1, -1]) {
        const x = sx * 0.029 * w, zf = front(x, yy);
        if (zf > 0) add(torso, ellipsoid(V(x, yy, zf - 0.017 * s), V(rw * w, 0.029 * s, 0.021 * s)), 0.018, 'abs');
      }
    }
    for (const sx of [1, -1]) add(torso, ellipsoid(V(sx * 0.1 * w, sy + 0.02 * s, 0.03 * w), V(0.045 * w, 0.1 * s, 0.06 * w)), 0.04, 'oblique');
  }
  const neck = [];
  add(neck, roundCone(V(0, ny - 0.04 * s, -0.012 * s), V(0, J.head.y + 0.03 * s, 0.0), 0.06 * b.neck * s, 0.05 * b.neck * s), 0, 'neck');
  const arms = { L: [], R: [] };
  const legs = { L: [], R: [] };
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const A = arms[side], Lg = legs[side];
    const ua = `upperArm.${side}`, la = `lowerArm.${side}`, ha = `hand.${side}`;
    const ra = b.arm * s;
    add(A, ellipsoid(P(ua, sx * 0.025 * s, 0.012 * s, -0.004 * s), V(0.078 * ra, 0.058 * ra, 0.06 * ra), Q[ua]), 0, 'deltoid'); // deltoid
    add(A, roundCone(J[ua], J[la], 0.046 * ra, 0.037 * ra), 0.04, 'upperarm');
    add(A, ellipsoid(P(ua, sx * 0.14 * s, 0.004 * s, 0.017 * ra), V(0.08 * s, 0.036 * ra * (0.85 + 0.2 * m), 0.037 * ra * (0.85 + 0.2 * m)), Q[ua]), 0.035, 'biceps'); // biceps
    add(A, ellipsoid(P(ua, sx * 0.11 * s, 0.0, -0.02 * ra), V(0.09 * s, 0.036 * ra, 0.036 * ra), Q[ua]), 0.035, 'triceps'); // triceps
    add(A, roundCone(J[la], P(ha, sx * 0.015 * s, 0, 0), 0.041 * ra, 0.026 * ra), 0.03, 'forearm');
    add(A, ellipsoid(P(la, sx * 0.075 * s, 0.006 * s, 0.002 * s), V(0.085 * s, 0.038 * ra, 0.043 * ra), Q[la]), 0.04, 'forearmMass'); // forearm mass
    const ul = `upperLeg.${side}`, ll = `lowerLeg.${side}`, ft = `foot.${side}`, to = `toes.${side}`;
    const rl = b.leg * s;
    add(Lg, roundCone(J[ul], J[ll], 0.088 * rl, 0.052 * rl), 0, 'thigh');
    add(Lg, ellipsoid(P(ul, sx * 0.008 * s, -0.19 * s, 0.022 * rl), V(0.068 * rl, 0.17 * s, 0.07 * rl)), 0.05, 'quads'); // quads
    add(Lg, ellipsoid(P(ul, sx * 0.03 * s, -0.12 * s, -0.01 * rl), V(0.07 * rl, 0.14 * s, 0.07 * rl)), 0.05, 'outerthigh'); // outer thigh
    add(Lg, ellipsoid(J[ll].clone().add(V(0, 0.005 * s, 0.012 * s)), V(0.05 * rl, 0.055 * s, 0.05 * rl)), 0.03, 'knee'); // knee
    add(Lg, roundCone(J[ll], J[ft], 0.05 * rl, 0.032 * rl), 0.03, 'shin');
    add(Lg, ellipsoid(P(ll, sx * 0.004 * s, -0.12 * s, -0.028 * rl), V(0.052 * rl, 0.1 * s, 0.05 * rl)), 0.04, 'calf'); // calf
    // foot: heel, arch, ball, toes
    add(Lg, ellipsoid(P(ft, 0, -0.045 * s, -0.035 * s), V(0.034 * s, 0.035 * s, 0.042 * s)), 0.03, 'heel');
    add(Lg, roundCone(P(ft, 0, -0.04 * s, -0.02 * s), P(to, 0, 0.0, 0.0), 0.034 * s, 0.03 * s), 0.03, 'arch');
    add(Lg, ellipsoid(P(to, sx * -0.002 * s, -0.004 * s, 0.035 * s), V(0.045 * s, 0.02 * s, 0.045 * s)), 0.03, 'toe');
  }
  return { torso, neck, arms, legs };
}

// ---------------------------------------------------------------------------------------------------------------
// weight field
// ---------------------------------------------------------------------------------------------------------------

function chain(joints, bones, blend) {
  // joints: Vector3[] (n+1), bones: names (n), blend: half widths at interior joints (n−1)
  const n = bones.length;
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + joints[i].distanceTo(joints[i + 1]));
  const segs = [];
  for (let i = 0; i < n; i++) {
    const a = joints[i], d = joints[i + 1].clone().sub(a);
    segs.push({ ax: a.x, ay: a.y, az: a.z, dx: d.x, dy: d.y, dz: d.z, l2: d.lengthSq(), len: Math.sqrt(d.lengthSq()) });
  }
  const idx = bones.map(b => BONE_INDEX[b]);
  return {
    // writes weights for this chain into out (dense, per bone) scaled by k
    apply(x, y, z, k, out) {
      let best = 1e9, sBest = 0;
      for (let i = 0; i < n; i++) {
        const S = segs[i];
        let t = ((x - S.ax) * S.dx + (y - S.ay) * S.dy + (z - S.az) * S.dz) / S.l2;
        const tc = Math.min(Math.max(t, 0), 1);
        const px = S.ax + S.dx * tc - x, py = S.ay + S.dy * tc - y, pz = S.az + S.dz * tc - z;
        const d = px * px + py * py + pz * pz;
        if (d < best) { best = d; sBest = cum[i] + (i === 0 ? Math.min(t, 1) : i === n - 1 ? Math.max(t, 0) : tc) * S.len; }
      }
      for (let i = 0; i < n; i++) {
        const lo = i === 0 ? 1 : smooth(cum[i] - blend[i - 1], cum[i] + blend[i - 1], sBest);
        const hi = i === n - 1 ? 0 : smooth(cum[i + 1] - blend[i], cum[i + 1] + blend[i], sBest);
        const wv = lo - hi;
        if (wv > 1e-4) out[idx[i]] += wv * k;
      }
    },
  };
}

/**
 * Build the analytic skin-weight field for a body. weightsAt(x, y, z, regions?, tau?) → dense Float32Array over
 * BONE_NAMES (reused buffer — copy it). regions: optional Set of 'torso','neck','armL','armR','legL','legR'.
 */
export function makeWeightField(bind, prims, b) {
  const { J } = bind;
  const s = bind.scale;
  const nB = BONE_NAMES.length;
  const out = new Float32Array(nB);
  const regionSDF = {
    torso: unionSDF(prims.torso, 0.05),
    neck: unionSDF(prims.neck, 0.02),
    armL: unionSDF(prims.arms.L, 0.03), armR: unionSDF(prims.arms.R, 0.03),
    legL: unionSDF(prims.legs.L, 0.03), legR: unionSDF(prims.legs.R, 0.03),
  };
  const regionNames = Object.keys(regionSDF);
  const chains = {};
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const handEnd = bind.P(`hand.${side}`, sx * 0.2 * s, 0, 0);
    chains['arm' + side] = chain([J[`shoulder.${side}`], J[`upperArm.${side}`], J[`lowerArm.${side}`], J[`hand.${side}`], handEnd],
      [`shoulder.${side}`, `upperArm.${side}`, `lowerArm.${side}`, `hand.${side}`], [0.05 * s, 0.04 * s, 0.022 * s]);
    const toeEnd = J[`toes.${side}`].clone().add(V(0, 0, 0.09 * s));
    chains['leg' + side] = chain([J[`upperLeg.${side}`], J[`lowerLeg.${side}`], J[`foot.${side}`], J[`toes.${side}`], toeEnd],
      [`upperLeg.${side}`, `lowerLeg.${side}`, `foot.${side}`, `toes.${side}`], [0.05 * s, 0.035 * s, 0.02 * s]);
  }
  chains.neck = chain([J.neck, J.head, J.hat.clone().add(V(0, 0.1, 0))], ['neck', 'head'], [0.035 * s]);
  const iH = BONE_INDEX.hips, iS = BONE_INDEX.spine, iC = BONE_INDEX.chest, iSL = BONE_INDEX['shoulder.L'], iSR = BONE_INDEX['shoulder.R'];
  const ySpine = J.spine.y, yChest = J.chest.y;
  const dists = new Float32Array(regionNames.length);
  return function weightsAt(x, y, z, regions = null, tau = 0.014) {
    out.fill(0);
    let dmin = 1e9;
    for (let r = 0; r < regionNames.length; r++) {
      const nm = regionNames[r];
      if (regions && !regions.has(nm)) { dists[r] = 1e9; continue; }
      const d = regionSDF[nm](x, y, z);
      dists[r] = d; if (d < dmin) dmin = d;
    }
    let tot = 0;
    for (let r = 0; r < regionNames.length; r++) {
      if (dists[r] >= 1e8) continue;
      const k = Math.exp(-(dists[r] - dmin) / tau);
      if (k < 1e-3) continue;
      tot += k;
      const nm = regionNames[r];
      if (nm === 'torso') {
        const wS = smooth(ySpine - 0.05 * s, ySpine + 0.04 * s, y);
        const wC = smooth(yChest - 0.06 * s, yChest + 0.05 * s, y);
        let wh = 1 - wS, ws = wS - wC, wc = wC;
        // clavicle region: upper chest toward the shoulders
        const sh = smooth(0.06 * s, 0.17 * s, Math.abs(x)) * smooth(J.chest.y + 0.08 * s, J.chest.y + 0.17 * s, y) * 0.85;
        out[iH] += wh * k; out[iS] += ws * k; out[iC] += wc * (1 - sh) * k;
        out[x > 0 ? iSL : iSR] += wc * sh * k;
      } else {
        chains[nm].apply(x, y, z, k, out);
      }
    }
    if (tot > 0) for (let i = 0; i < nB; i++) out[i] /= tot;
    return out;
  };
}

/** Reduce dense weights to the top 4 (normalised). Writes into idx4/w4 at offset o. */
export function top4(dense, idx4, w4, o) {
  let a0 = -1, a1 = -1, a2 = -1, a3 = -1, v0 = 0, v1 = 0, v2 = 0, v3 = 0;
  for (let i = 0; i < dense.length; i++) {
    const v = dense[i];
    if (v <= v3) continue;
    if (v > v0) { a3 = a2; v3 = v2; a2 = a1; v2 = v1; a1 = a0; v1 = v0; a0 = i; v0 = v; }
    else if (v > v1) { a3 = a2; v3 = v2; a2 = a1; v2 = v1; a1 = i; v1 = v; }
    else if (v > v2) { a3 = a2; v3 = v2; a2 = i; v2 = v; }
    else { a3 = i; v3 = v; }
  }
  const t = v0 + v1 + v2 + v3 || 1;
  idx4[o] = Math.max(a0, 0); idx4[o + 1] = Math.max(a1, 0); idx4[o + 2] = Math.max(a2, 0); idx4[o + 3] = Math.max(a3, 0);
  w4[o] = v0 / t; w4[o + 1] = v1 / t; w4[o + 2] = v2 / t; w4[o + 3] = v3 / t;
}

/**
 * Compute dense weights for every vertex of a mesh, Laplacian-smooth them over the surface, and store the top 4
 * as mesh.skin = { index: Float32Array(4n), weight: Float32Array(4n) }. `weightsFn(x,y,z)` returns a dense array.
 */
export function skinMesh(mesh, weightsFn, { passes = 2, nBones = BONE_NAMES.length } = {}) {
  const P = mesh.positions, nv = P.length / 3;
  const dense = new Float32Array(nv * nBones);
  for (let v = 0; v < nv; v++) dense.set(weightsFn(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]).subarray(0, nBones), v * nBones);
  if (passes > 0) smoothField(dense, nBones, adjacency(nv, mesh.indices), passes, 0.5);
  const index = new Float32Array(nv * 4), weight = new Float32Array(nv * 4);
  for (let v = 0; v < nv; v++) top4(dense.subarray(v * nBones, (v + 1) * nBones), index, weight, v * 4);
  mesh.skin = { index, weight };
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------
// head
// ---------------------------------------------------------------------------------------------------------------

/** Head primitives in head-bone-local coordinates (metres at scale 1). */
export function headPrimitives(b, faceSeed = 0.5) {
  // Facial planes are built from bony landmarks with tight blends (brow ridge, zygomatic arch, ramus + mandible,
  // chin, nasal bridge/tip/alae) so the face reads as planes under a raking sun instead of a soft blob. Heavier
  // builds get a wider jaw and cheekbones; faceSeed varies nose and jaw a little.
  const L = [];
  const add = (p, k) => { p.k = k; L.push(p); return p; };
  const sub = (p, k) => { p.k = k; p.sub = true; L.push(p); return p; };
  const jaw = 1 + (b.girth - 1) * 0.3, fs = faceSeed;
  const q = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
  add(ellipsoid(V(0, 0.074, -0.014), V(0.076, 0.09, 0.097)), 0); // cranium
  add(ellipsoid(V(0, 0.076, 0.03), V(0.063, 0.057, 0.06)), 0.03); // forehead
  for (const sx of [1, -1]) {
    add(roundCone(V(sx * 0.006, 0.049, 0.092), V(sx * 0.052, 0.054, 0.072), 0.0105, 0.0075), 0.012); // supraorbital ridge
    add(ellipsoid(V(sx * 0.049 * jaw, 0.019, 0.064), V(0.019, 0.0135, 0.021), q(0, sx * 0.55, 0)), 0.012); // cheekbone
    add(roundCone(V(sx * 0.053 * jaw, 0.021, 0.055), V(sx * 0.068, 0.027, 0.008), 0.0105, 0.008), 0.012); // zygomatic arch
    const angle = V(sx * 0.057 * jaw, -0.03 - 0.004 * fs, 0.004);
    add(roundCone(V(sx * 0.06, 0.016, -0.01), angle, 0.014, 0.0125), 0.012); // ramus
    add(roundCone(angle, V(sx * 0.02 * jaw, -0.058, 0.071), 0.0125, 0.0115), 0.013); // mandible body
    add(ellipsoid(V(sx * 0.074, 0.03, -0.006), V(0.011, 0.029, 0.019), q(0, sx * -0.35, sx * 0.1)), 0.012); // ear
    add(ellipsoid(V(sx * 0.028, -0.004, 0.08), V(0.02, 0.022, 0.018)), 0.02); // maxilla side
  }
  add(ellipsoid(V(0, -0.056, 0.077), V(0.021 * jaw, 0.016, 0.016)), 0.012); // chin
  add(ellipsoid(V(0, -0.006, 0.079), V(0.028, 0.03, 0.025)), 0.022); // muzzle
  add(roundCone(V(0, 0.047, 0.094), V(0, 0.015, 0.111 + 0.003 * fs), 0.0066, 0.0092), 0.01); // nasal bridge
  add(ellipsoid(V(0, 0.009, 0.112 + 0.003 * fs), V(0.0112, 0.0102, 0.0102)), 0.007); // nose tip
  for (const sx of [1, -1]) add(ellipsoid(V(sx * 0.0132, 0.0055, 0.103), V(0.0082, 0.0074, 0.0082)), 0.005); // alae
  add(roundCone(V(-0.018, -0.0165, 0.0985), V(0.018, -0.0165, 0.0985), 0.0056, 0.0056), 0.007); // upper lip
  add(roundCone(V(-0.015, -0.0275, 0.0955), V(0.015, -0.0275, 0.0955), 0.006, 0.006), 0.007); // lower lip
  add(roundCone(V(0, -0.115, -0.022), V(0, 0.02, -0.018), 0.057 * b.neck, 0.052 * b.neck), 0.03); // neck top
  // carved: eye sockets under the brow, cheek hollows under the zygomatic, mouth line, philtrum
  for (const sx of [1, -1]) {
    sub(ellipsoid(V(sx * 0.032, 0.035, 0.099), V(0.0195, 0.0135, 0.0145)), 0.009);
    sub(ellipsoid(V(sx * 0.047, -0.016, 0.079), V(0.011, 0.016, 0.011)), 0.016);
  }
  sub(roundCone(V(-0.017, -0.0222, 0.105), V(0.017, -0.0222, 0.105), 0.0021, 0.0021), 0.003);
  // eyeballs and upper lids
  for (const sx of [1, -1]) {
    add(ellipsoid(V(sx * 0.032, 0.035, 0.084), V(0.0125, 0.0125, 0.0125)), 0.003);
    add(ellipsoid(V(sx * 0.032, 0.0405, 0.0875), V(0.0145, 0.0062, 0.0105), q(0.35, 0, 0)), 0.004);
  }
  return L;
}

/** Head signed-distance field (head-local, scale 1) — shared with facial hair (outfitsHead.beard). */
export function headSDF(b, faceSeed = 0.5) { return unionSDF(headPrimitives(b, faceSeed), 0.02); }

// ---------------------------------------------------------------------------------------------------------------
// hands (canonical LEFT hand in hand-bone space: +x toward the fingers, −y palm, +z thumb)
// ---------------------------------------------------------------------------------------------------------------

const FINGERS = [ // z offset at the knuckle, phalanx lengths, radius
  { z: 0.03, len: [0.044, 0.026, 0.02], r: 0.0092 },
  { z: 0.0095, len: [0.049, 0.03, 0.022], r: 0.0096 },
  { z: -0.0105, len: [0.046, 0.028, 0.021], r: 0.009 },
  { z: -0.029, len: [0.036, 0.021, 0.018], r: 0.0078 },
];

/** Finger joint chains for a pose. Returns [{pts:[mcp,pip,dip,tip], r}] + thumb. */
function handPose(pose, gripR = 0.015) {
  const out = [];
  const knX = 0.086;
  if (pose === 'grip' || pose === 'fist') {
    // fingers curl on a circle slightly larger than (grip radius + finger radius), centred just in front of the
    // weapon socket (0.085, −0.01): the handle passes through the hole of the fist without touching the fingers.
    const grip = pose === 'grip';
    const cx = grip ? 0.089 : 0.08, cy = grip ? -0.014 : -0.006, RR = grip ? 0.031 : 0.021;
    for (const f of FINGERS) {
      let ang = Math.PI * 0.56;
      const pts = [V(cx + Math.cos(ang) * RR, cy + Math.sin(ang) * RR, f.z)];
      for (const L of f.len) {
        ang -= 2 * Math.asin(Math.min(L / (2 * RR), 0.999));
        pts.push(V(cx + Math.cos(ang) * RR, cy + Math.sin(ang) * RR, f.z * 0.96));
      }
      out.push({ pts, r: f.r });
    }
    // thumb closes over the index/middle middle phalanges
    out.push({ pts: [V(0.02, 0.0, 0.03), V(0.052, -0.02, 0.05), V(0.086, -0.038, 0.036), V(0.106, -0.04, 0.016)], r: 0.0105 });
  } else if (pose === 'swordfinger') {
    FINGERS.forEach((f, i) => {
      const pts = [V(knX, 0.004, f.z)];
      if (i < 2) { // index + middle straight, pressed together
        let x = knX, z = f.z * 0.55 + (i === 0 ? 0.004 : -0.004);
        for (const L of f.len) { x += L; pts.push(V(x, 0.002 - (x - knX) * 0.05, z)); }
      } else { // ring + pinky curled into the palm
        const angs = [1.35, 1.6, 1.2]; let a = 0, p = pts[0].clone();
        for (let j = 0; j < 3; j++) { a += angs[j]; p = p.clone().add(V(Math.cos(a) * f.len[j], -Math.sin(a) * f.len[j], 0)); pts.push(p); }
      }
      out.push({ pts, r: f.r });
    });
    out.push({ pts: [V(0.018, -0.008, 0.028), V(0.048, -0.026, 0.045), V(0.074, -0.034, 0.018), V(0.09, -0.03, -0.004)], r: 0.0105 });
  } else { // relaxed
    FINGERS.forEach((f, i) => {
      const curl = [0.25, 0.4, 0.3].map(c => c * (1 + i * 0.15));
      let a = 0, p = V(knX, 0.004, f.z * 1.05);
      const pts = [p];
      for (let j = 0; j < 3; j++) { a += curl[j]; p = p.clone().add(V(Math.cos(a) * f.len[j], -Math.sin(a) * f.len[j], 0)); pts.push(p); }
      out.push({ pts, r: f.r });
    });
    out.push({ pts: [V(0.018, -0.008, 0.028), V(0.05, -0.022, 0.052), V(0.078, -0.03, 0.058), V(0.098, -0.034, 0.056)], r: 0.0105 });
  }
  return out;
}

function handPrimitives(pose, b) {
  const L = [];
  const add = (p, k) => { p.k = k; L.push(p); return p; };
  const w = 0.95 + 0.1 * (b.arm - 1);
  add(ellipsoid(V(-0.008, 0.001, 0), V(0.03, 0.022 * w, 0.03 * w)), 0); // wrist
  const palmY = pose === 'grip' ? 0.017 : pose === 'fist' ? 0.01 : 0.0;
  add(roundBox(V(0.047, palmY, 0.001), V(0.046, 0.0145 * w, 0.041 * w), 0.013), 0.02); // palm
  add(ellipsoid(V(0.03, palmY - 0.012, 0.028), V(0.03, 0.016, 0.02)), 0.02); // thenar
  add(ellipsoid(V(0.04, palmY - 0.01, -0.03), V(0.035, 0.013, 0.014)), 0.02); // hypothenar
  for (const f of handPose(pose)) {
    const { pts, r } = f;
    for (let i = 0; i < pts.length - 1; i++) {
      const ra = r * (1 - i * 0.07), rb = r * (1 - (i + 1) * 0.07);
      add(roundCone(pts[i], pts[i + 1], ra * w, rb * w), i === 0 ? 0.012 : 0.004);
    }
    // knuckle bump
    add(ellipsoid(pts[0].clone().add(V(0, 0.003, 0)), V(r * 1.15, r * 1.05, r * 1.1)), 0.008);
  }
  return L;
}

// ---------------------------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------------------------

const cache = new Map();
/** Triangle budgets after decimation. */
export const TRI = { body: 7000, head: 3000, hand: 1100 };

/**
 * Build a body. Returns {
 *   bind, build, weightsAt, prims, sdf,
 *   body: mesh (bind space, extras: color), head: mesh, hands: {L, R}: meshes
 * } where mesh = { positions, normals, indices, extra:{color:{size:3,array}} }. Meshes are cached per build key
 * and CLONED for each caller (callers mutate them).
 */
export function buildBody({ kind = 'hero', build, handPoses = { L: 'relaxed', R: 'grip' }, faceSeed = 0.5, voxel = 0.017, skin = 'full' }) {
  const b = build;
  const key = JSON.stringify([b, handPoses, faceSeed, voxel, skin, MESH_LOD.tris]);
  if (!cache.has(key)) cache.set(key, buildBodyUncached(b, handPoses, faceSeed, voxel, skin));
  const c = cache.get(key);
  const clone = (m) => m && ({ positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), extra: Object.fromEntries(Object.entries(m.extra || {}).map(([k, v]) => [k, { size: v.size, array: v.array.slice() }])) });
  return { ...c, body: clone(c.body), head: clone(c.head), hands: { L: clone(c.hands.L), R: clone(c.hands.R) } };
}

/**
 * Visible-skin modes: garments hide most of the body, so only the skin that can ever be seen is polygonised
 * (fewer triangles, no poke-through). neck = head/neck/hands only; arms = + bare arms; torso = + open chest/belly.
 */
const SKIN_MODES = {
  neck: { box: [[-0.15, 1.34, -0.15], [0.15, 1.6, 0.15]], tris: 900, keep: (x, y, z, s) => 1.40 * s - y },
  arms: { box: [[-0.62, 0.9, -0.25], [0.62, 1.6, 0.25]], tris: 4200, keep: (x, y, z, s) => Math.min(1.40 * s - y, 0.2 * s - Math.abs(x)) },
  torso: { box: [[-0.62, 0.9, -0.25], [0.62, 1.6, 0.28]], tris: 6000, keep: (x, y, z, s) => 1.0 * s - y },
  full: { box: [[-0.62, -0.02, -0.25], [0.62, 1.66, 0.25]], tris: 7000, keep: () => -1 },
};

function buildBodyUncached(b, handPoses, faceSeed, voxel, skinMode = 'full') {
  const bind = makeBindRig(b.scale);
  const s = b.scale;
  const prims = bodyPrimitives(bind, b);
  // one flat smooth union: limb items carry their own blend radii (deltoid/thigh blend into the torso)
  const sdf = unionSDF([...prims.torso, ...prims.neck, ...prims.arms.L, ...prims.arms.R, ...prims.legs.L, ...prims.legs.R], 0.03);
  const weightsAt = makeWeightField(bind, prims, b);

  // --- body (without head and hands)
  const mode = SKIN_MODES[skinMode] || SKIN_MODES.full;
  const bb = new THREE.Box3(V(...mode.box[0]).multiplyScalar(s), V(...mode.box[1]).multiplyScalar(s));
  let body = meshSDF(sdf, bb.min, bb.max, voxel * s, mode.tris);
  const wristL = bind.J['hand.L'], wristR = bind.J['hand.R'];
  const armDirL = bind.J['hand.L'].clone().sub(bind.J['lowerArm.L']).normalize();
  const armDirR = bind.J['hand.R'].clone().sub(bind.J['lowerArm.R']).normalize();
  // wrist cut: a half-space past the wrist, limited to a cylinder around the forearm axis (else it cuts the legs)
  const wristCut = (x, y, z, w, d) => {
    const px = x - w.x, py = y - w.y, pz = z - w.z;
    const along = px * d.x + py * d.y + pz * d.z;
    const rx = px - d.x * along, ry = py - d.y * along, rz = pz - d.z * along;
    const radial = Math.sqrt(rx * rx + ry * ry + rz * rz);
    return Math.min(along - 0.012 * s, 0.07 * s - radial);
  };
  body = clipMesh(body, (x, y, z) => {
    // cut at the upper neck (the head mesh takes over) and just past the wrists (hands take over)
    const cN = y - (bind.J.head.y - 0.035 * s);
    return Math.max(cN, wristCut(x, y, z, wristL, armDirL), wristCut(x, y, z, wristR, armDirR), mode.keep(x, y, z, s));
  }, { snap: true });
  projectToSDF(body, sdf, 0);
  body.extra = { color: { size: 3, array: skinColors(body, b, 'body', bind) } };

  // --- head (finer voxels) in head space → bind
  const hsdf = headSDF(b, faceSeed);
  let head = meshSDF(hsdf, V(-0.1, -0.12, -0.13), V(0.1, 0.18, 0.13), 0.005, TRI.head);
  head = clipMesh(head, (x, y, z) => -(y + 0.085), { snap: true }); // open at the neck; body neck continues below
  projectToSDF(head, hsdf, 0);
  head.extra = { color: { size: 3, array: skinColors(head, b, 'head') } };
  const hm = new THREE.Matrix4().compose(bind.J.head, bind.Q.head, V(s, s, s));
  transformMesh(head, hm);

  // --- hands
  const hands = {};
  for (const side of ['L', 'R']) {
    const pose = handPoses[side] || 'relaxed';
    const hsd = unionSDF(handPrimitives(pose, b), 0.01);
    let hand = meshSDF(hsd, V(-0.045, -0.075, -0.07), V(0.14, 0.05, 0.08), 0.0045, TRI.hand);
    hand = clipMesh(hand, (x) => -(x + 0.028), { snap: true });
    projectToSDF(hand, hsd, 0);
    hand.extra = { color: { size: 3, array: skinColors(hand, b, 'hand') } };
    const m = new THREE.Matrix4().compose(V(0, 0, 0), new THREE.Quaternion(), V(side === 'L' ? s : -s, s, s));
    transformMesh(hand, m); // mirror for the right hand (flips winding)
    transformMesh(hand, new THREE.Matrix4().compose(bind.J[`hand.${side}`], bind.Q[`hand.${side}`], V(1, 1, 1)));
    hands[side] = hand;
  }
  return { bind, build: b, prims, sdf, weightsAt, body, head, hands };
}

// ---------------------------------------------------------------------------------------------------------------
// skin colour (linear albedo, with baked cavity darkening)
// ---------------------------------------------------------------------------------------------------------------

function skinColors(mesh, b, part) {
  const P = mesh.positions, nv = P.length / 3;
  const out = new Float32Array(nv * 3);
  const [r0, g0, b0] = b.skin;
  for (let v = 0; v < nv; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    let r = r0, g = g0, bl = b0;
    if (part === 'head') {
      // redder nose tip, cheeks, ears and lips; darker eye sockets; stubble around the jaw and upper lip
      const nose = Math.exp(-((x * x) / 0.0004 + (y - 0.012) ** 2 / 0.0006 + (z - 0.11) ** 2 / 0.0004));
      const cheek = Math.exp(-((Math.abs(x) - 0.045) ** 2 / 0.0006 + (y - 0.01) ** 2 / 0.0006 + (z - 0.07) ** 2 / 0.0012));
      const ear = Math.exp(-((Math.abs(x) - 0.075) ** 2 / 0.0003 + (y - 0.03) ** 2 / 0.001 + z * z / 0.0008));
      const lips = Math.exp(-(x * x / 0.0004 + (y + 0.022) ** 2 / 0.00008 + (z - 0.098) ** 2 / 0.0002));
      const flush = Math.min(1, nose * 0.7 + cheek * 0.35 + ear * 0.6 + lips * 0.8);
      r *= 1 + 0.1 * flush; g *= 1 - 0.05 * flush; bl *= 1 - 0.03 * flush;
      // eye area: slightly darker, cooler lids; muted sclera and dark iris (read as shadowed eyes, never as holes)
      const ax = Math.abs(x) - 0.032, ey = y - 0.035;
      const eye = Math.exp(-(ax * ax / 0.0004 + ey * ey / 0.00025 + (z - 0.09) ** 2 / 0.0008));
      const socket = 1 - 0.22 * eye;
      r *= socket; g *= socket; bl *= socket * 1.02;
      const dEye = Math.hypot(ax, ey, z - 0.084);
      if (dEye < 0.0135 && z > 0.088 && y < 0.0395) {
        const iris = smooth(0.0075, 0.0045, Math.hypot(ax, ey));
        r = mix(0.25, 0.028, iris); g = mix(0.225, 0.02, iris); bl = mix(0.205, 0.016, iris);
      }
      // stubble / beard shadow: jaw, chin and upper lip (bandits), a faint shave shadow on everyone
      const jawZone = smooth(0.016, -0.012, y - 0.4 * (Math.abs(x) - 0.03)) * smooth(-0.015, 0.02, z) * smooth(-0.085, -0.06, y)
        + Math.exp(-(x * x / 0.0005 + (y + 0.008) ** 2 / 0.00003 + (z - 0.1) ** 2 / 0.0003));
      const lipFree = 1 - Math.exp(-(x * x / 0.0003 + (y + 0.022) ** 2 / 0.00004 + (z - 0.1) ** 2 / 0.0002));
      const st = Math.min(1, jawZone) * lipFree * b.stubble;
      r = r * (1 - 0.5 * st) + 0.028 * st; g = g * (1 - 0.5 * st) + 0.024 * st; bl = bl * (1 - 0.45 * st) + 0.022 * st;
      // eyebrows along the supraorbital ridge
      const brow = Math.exp(-((Math.abs(x) - 0.031) ** 2 / 0.00035 + (y - 0.052 - 0.08 * (Math.abs(x) - 0.03)) ** 2 / 0.000022 + (z - 0.095) ** 2 / 0.0004));
      const bw = Math.min(1, brow * 1.3);
      r = r * (1 - 0.8 * bw) + 0.015 * bw; g = g * (1 - 0.8 * bw) + 0.012 * bw; bl = bl * (1 - 0.8 * bw) + 0.01 * bw;
    } else if (part === 'hand') {
      // knuckles and fingertips warmer, palm lighter
      const palm = smooth(0.0, -0.02, y);
      r *= 1 + 0.08 * palm; g *= 1 + 0.02 * palm;
      const tips = smooth(0.1, 0.14, x);
      r *= 1 + 0.08 * tips; g *= 1 - 0.04 * tips;
    } else {
      // torso slightly paler (less sun), forearms/neck more tanned
      const torso = smooth(0.2, 0.1, Math.abs(x)) * smooth(0.85, 1.0, y) * smooth(1.45, 1.35, y);
      r *= 1 + 0.06 * torso; g *= 1 + 0.08 * torso; bl *= 1 + 0.1 * torso;
    }
    out[v * 3] = r; out[v * 3 + 1] = g; out[v * 3 + 2] = bl;
  }
  return out;
}
