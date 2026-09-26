// Garments (owner: character C). Pure geometry, worker-safe. Every builder takes the build context `ctx`
// (bind rig, body primitives, weight field, rig spec, assembly, rng) and adds skinned parts to ctx.asm.
//
//   robe(ctx, o)       upper garment shell: torso + sleeves (wide / narrow / rolled / none), cross collar, trims
//   innerLayer(ctx, o) the inner cross-collar layer visible in the V of the outer robe
//   sash(ctx, o)       waist band + knot + two trailing tails (cloth chains)
//   skirt(ctx, o)      lower robe / tunic skirt: ring of cloth chains, split into panels at the slits
//   trousers, legWraps, shoes, vest, bracers, belt
// Recipes per character kind live in outfitsRecipes.js.
import { unionSDF, computeNormals } from './humanoidSdf.js';
import { BONE_INDEX } from './humanoid.js';
import { COL } from './cloth.js';
import {
  V, clamp, sstep, mix, vnoise3, inflate, garmentSDF, sdPoly2, axisCut, shell, edgeDistances, paint, hem,
  skinDense, sdfAO, catmull, tube, merge, trimBand,
} from './outfitsKit.js';

const RIG_SLOTS = Array.from({ length: Object.keys(BONE_INDEX).length }, (_, i) => i);
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------------------------------------------

/** Forearm / upper-arm frames for one side in bind space. */
export function armFrame(ctx, side) {
  const J = ctx.J;
  const sh = J[`upperArm.${side}`], el = J[`lowerArm.${side}`], wr = J[`hand.${side}`];
  const fx = wr.clone().sub(el).normalize();                                  // forearm direction
  const fy = V(0, 1, 0).addScaledVector(fx, -fx.y).normalize();                // "up" ⟂ forearm
  const fz = fx.clone().cross(fy);
  const ux = el.clone().sub(sh).normalize();
  return { sh, el, wr, fx, fy, fz, ux, fl: wr.distanceTo(el), ul: el.distanceTo(sh) };
}

/** Distance from p to segment ab. */
function segDist(x, y, z, a, b) {
  const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
  const t = clamp(((x - a.x) * bx + (y - a.y) * by + (z - a.z) * bz) / (bx * bx + by * by + bz * bz), 0, 1);
  return Math.hypot(x - a.x - bx * t, y - a.y - by * t, z - a.z - bz * t);
}

/** Body weights with a region override for points that clearly belong to one sleeve / leg. */
function bodyWeights(ctx) {
  const armL = new Set(['armL']), armR = new Set(['armR']);
  const AL = armFrame(ctx, 'L'), AR = armFrame(ctx, 'R');
  const s = ctx.s;
  return (x, y, z, out) => {
    let regions = null;
    if (Math.abs(x) > 0.21 * s) {
      const A = x > 0 ? AL : AR;
      if (Math.min(segDist(x, y, z, A.sh, A.el), segDist(x, y, z, A.el, A.wr)) < 0.2 * s) regions = x > 0 ? armL : armR;
    }
    const w = ctx.weightsAt(x, y, z, regions);
    for (let i = 0; i < w.length; i++) out[i] = w[i];
  };
}

/** Linear colour helpers. */
const scale3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Fabric mottling: low-frequency value variation (dye unevenness, wear) ±amp. */
function mottle(x, y, z, amp = 0.05, f = 9) {
  return 1 + amp * (vnoise3(x * f, y * f, z * f) * 2 - 1) + amp * 0.5 * (vnoise3(x * f * 3.1, y * f * 3.1, z * f * 3.1) * 2 - 1);
}

/** Dust / dirt toward the ground (hems and shoes pick up the steppe). */
function dust(y, s, amount = 1) { return 1 - 0.22 * amount * sstep(0.55 * s, 0.05 * s, y); }
const DUST_TINT = [0.36, 0.30, 0.2];

// ---------------------------------------------------------------------------------------------------------------
// robe (upper garment shell)
// ---------------------------------------------------------------------------------------------------------------

/**
 * o = { t, drape, sleeve: 'wide'|'narrow'|'rolled'|'none', cuff (m past wrist, negative = shorter), waistY,
 *       collar: 'cross'|'open'|'none', color, trim, trimW, cuffTrimW, lining, flutter, bag, name,
 *       blouse (bulge above the sash), folds (0..1), openFront (vest) }
 */
export function robe(ctx, o) {
  const { J, s, prims } = ctx;
  const t = (o.t ?? 0.024) * s;
  const items = [];
  const torsoTags = o.torsoTags ?? ['chest', 'waist', 'belly', 'pec', 'lat', 'trap', 'upperback', 'pelvis'];
  for (const p of prims.torso) if (torsoTags.includes(p.tag)) items.push(inflate(p, t, Math.max(p.k, (o.drape ?? 0.06) * s)));
  if (o.collar !== 'none') items.push(inflate(prims.neck[0], (o.neckT ?? 0.017) * s, 0.05 * s));
  const arms = {};
  for (const side of ['L', 'R']) {
    const A = armFrame(ctx, side);
    arms[side] = A;
    if (o.sleeve === 'none') {
      for (const p of prims.arms[side]) if (p.tag === 'deltoid') items.push(inflate(p, t * 0.8, 0.05 * s));
      continue;
    }
    for (const p of prims.arms[side]) if (['deltoid', 'upperarm', 'biceps', 'triceps'].includes(p.tag)) items.push(inflate(p, t, 0.05 * s));
    const cuffLen = (o.cuff ?? 0.03) * s;
    const cuffPt = A.wr.clone().addScaledVector(A.fx, cuffLen + 0.03 * s);
    if (o.sleeve === 'wide') {
      items.push({ ...roundConeP(A.sh.clone().addScaledVector(A.ux, 0.045 * s), A.el, 0.058 * s, 0.08 * s), k: 0.05 * s });
      items.push({ ...roundConeP(A.el.clone().addScaledVector(A.fy, -0.012 * s), cuffPt.clone().addScaledVector(A.fy, -0.02 * s), 0.09 * s, 0.104 * s), k: 0.05 * s });
      // the bag: loose cloth hanging under the forearm
      const bc = A.el.clone().lerp(A.wr, 0.62).addScaledVector(A.fy, -0.07 * s).addScaledVector(A.fz, -0.008 * s);
      items.push({ ...ellipsoidFrame(bc, [0.17 * s, 0.095 * s, 0.078 * s], A.fx, A.fy, A.fz), k: 0.07 * s });
    } else if (o.sleeve === 'narrow' || o.sleeve === 'rolled') {
      const r0 = (o.sleeveR ?? 0.06) * s;
      items.push({ ...roundConeP(A.sh.clone().addScaledVector(A.ux, 0.02 * s), A.el, r0 * 1.05, r0), k: 0.04 * s });
      const end = o.sleeve === 'rolled' ? A.el.clone().lerp(A.wr, 0.45) : cuffPt;
      items.push({ ...roundConeP(A.el, end, r0 * 0.98, r0 * (o.sleeve === 'rolled' ? 1.0 : 0.86)), k: 0.04 * s });
      if (o.sleeve === 'rolled') items.push({ ...roundConeP(end.clone().addScaledVector(A.fx, -0.035 * s), end.clone().addScaledVector(A.fx, 0.005 * s), r0 * 1.12, r0 * 1.12), k: 0.012 * s });
    }
  }
  // fold / bulge field
  const waistY = (o.waistY ?? 1.03) * s;
  const foldK = o.folds ?? 1;
  const disp = (x, y, z) => {
    let d = 0;
    // blousing just above the sash: the robe is tucked and pushed out, with radial pleats
    const by = (o.blouseY ?? (waistY / s + 0.075)) * s;   // top of the sash: the robe puffs out just above it
    const bl = sstep(by - 0.01 * s, by + 0.03 * s, y) * sstep(by + 0.17 * s, by + 0.05 * s, y) * (o.blouse ?? 0.012) * s;
    if (bl > 0 && Math.abs(x) < 0.25 * s) {
      const th = Math.atan2(x, z);
      d += bl * (0.7 + 0.5 * Math.sin(th * 13 + vnoise3(x * 20, 0, z * 20) * 2.5));
    }
    // sleeve drape folds (along the forearm, rotating around it) + soft rings
    if (o.sleeve !== 'none' && Math.abs(x) > 0.2 * s) {
      const A = x > 0 ? arms.L : arms.R;
      const px = x - A.el.x, py = y - A.el.y, pz = z - A.el.z;
      const a = (px * A.fx.x + py * A.fx.y + pz * A.fx.z) / A.fl;
      const vy = px * A.fy.x + py * A.fy.y + pz * A.fy.z, vz = px * A.fz.x + py * A.fz.y + pz * A.fz.z;
      const phi = Math.atan2(vz, vy);
      const k = sstep(-0.9, -0.1, a) * foldK * (o.sleeve === 'wide' ? 1 : 0.5);
      d += k * s * (0.0055 * Math.sin(phi * 3 + a * 4.5 + 1.3) + 0.0035 * Math.sin(a * 17 + phi * 1.5) * sstep(0.5, -0.4, Math.cos(phi)));
      // elbow compression wrinkles
      d += foldK * s * 0.003 * Math.sin(a * 38) * Math.exp(-a * a * 30);
    }
    // gentle diagonal pull folds across the chest from the collar cross (asymmetric)
    if (y > waistY && Math.abs(x) < 0.2 * s && z > 0) {
      d += foldK * s * 0.0025 * Math.sin((x * 0.8 + y) * 55) * sstep(waistY, waistY + 0.2 * s, y) * sstep(J.neck.y, J.chest.y, y);
    }
    return d;
  };
  const sdf = garmentSDF(items, 0.05 * s, disp, 0.02 * s);
  // ---- clip: waist, collar (neck hole + V), cuffs / armholes, open front
  const ny = J.neck.y;
  const V1 = o.vShape ?? [[0.078, -0.02], [0.078, 0.22], [-0.078, 0.22], [-0.078, -0.02], [-0.045, -0.215]];
  const vpoly = V1.map(([px, py]) => [px * s, ny + py * s]);
  const neckR = (o.neckR ?? 0.088) * s, collarY = ny + (o.collarDY ?? -0.02) * s;
  const cuffs = {};
  for (const side of ['L', 'R']) {
    const A = arms[side];
    if (o.sleeve === 'none') cuffs[side] = { c: A.sh.clone().addScaledVector(A.ux, (o.armhole ?? 0.0) * s), n: A.ux, r: 0.14 * s };
    else if (o.sleeve === 'rolled') cuffs[side] = { c: A.el.clone().lerp(A.wr, 0.45), n: A.fx, r: 0.16 * s };
    else cuffs[side] = { c: A.wr.clone().addScaledVector(A.fx, (o.cuff ?? 0.03) * s), n: A.fx, r: 0.2 * s };
  }
  const clip = (x, y, z) => {
    const cw = Math.abs(x) < 0.27 * s ? waistY - y : -1;
    const zc = mix(-0.032 * s, 0, clamp((y - ny + 0.04 * s) / (0.17 * s), 0, 1));
    const rn = Math.hypot(x, z - zc);
    let cn = Math.min(y - collarY, neckR - rn);
    if (o.collar === 'cross' && z > 0) cn = Math.max(cn, -sdPoly2(x, y, vpoly));
    if (o.openFront && z > 0) cn = Math.max(cn, Math.min(o.openFront * s - Math.abs(x + (o.openShift ?? 0) * s), y - waistY + 0.05));
    const cl = axisCut(x, y, z, cuffs.L.c, cuffs.L.n, cuffs.L.r), cr = axisCut(x, y, z, cuffs.R.c, cuffs.R.n, cuffs.R.r);
    return Math.max(cw, cn, cl, cr);
  };
  const box = [V(-0.64, waistY - 0.14, -0.24).multiplyScalar(1), V(0.64, ny + 0.12 * s, 0.25)];
  box[0].x *= s; box[1].x *= s; box[0].z *= s; box[1].z *= s;
  let m = shell({ sdf, box, voxel: (o.voxel ?? 0.0155) * s, tris: o.tris ?? 9000, clip });
  const ao = sdfAO(m, sdf, { dist: 0.05 * s });
  const base = o.color, lining = o.lining ?? scale3(base, 0.85);
  paint(m, {
    color: (x, y, z) => scale3(base, mottle(x, y, z, o.mottle ?? 0.05) * (o.dirt ? dust(y, s, o.dirt) : 1)),
    color2: lining,
    cloth: (x, y, z, v) => [o.trans ?? 1, Math.abs(x) > 0.3 * s ? (o.flutter ?? 0.25) : 0, 1, ao[v]],
  });
  // skinning: body field + sleeve pendulum bones on the bag
  const W = bodyWeights(ctx);
  const slots = [...RIG_SLOTS];
  const bag = {};
  if (o.sleeve === 'wide' && o.bag !== false) {
    for (const side of ['L', 'R']) {
      const A = arms[side];
      const pivot = A.el.clone().lerp(A.wr, 0.55);
      const c = ctx.rig.chain({
        name: `${o.name ?? 'robe'}Bag${side}`, parent: `lowerArm.${side}`,
        nodes: [pivot.toArray(), pivot.clone().addScaledVector(A.fy, -0.13 * s).toArray()],
        pin: [1, 0.12], side: A.fx.toArray(), radius: 0.03, mask: 0, drag: 2.2, stiff: 0, flutter: 0.3,
      });
      bag[side] = { slot: slots.length, A, lo: BONE_INDEX[`lowerArm.${side}`] };
      slots.push(c.bone0);
    }
  }
  skinDense(m, (x, y, z, v, out) => {
    W(x, y, z, out);
    const side = x > 0 ? 'L' : 'R';
    const B = bag[side];
    if (B && Math.abs(x) > 0.24 * s) {
      const A = B.A;
      const px = x - A.el.x, py = y - A.el.y, pz = z - A.el.z;
      const a = (px * A.fx.x + py * A.fx.y + pz * A.fx.z) / A.fl;
      const below = -(px * A.fy.x + py * A.fy.y + pz * A.fy.z);
      const sb = 0.75 * sstep(0.02 * s, 0.1 * s, below) * sstep(-0.25, 0.35, a);
      if (sb > 0) { for (let i = 0; i < RIG_SLOTS.length; i++) out[i] *= 1 - sb; out[B.slot] += sb; }
    }
  }, slots, 2);
  // sewn-on bands along the collar / front opening and the cuffs (crisp, raised, rolled over the edge)
  const isCuff = (cx) => Math.abs(cx) > 0.25 * s;
  const isTop = (cx, cy) => cy > waistY + 0.03 * s;
  let trims = null;
  if (o.trim) {
    const tw = (o.trimW ?? 0.04) * s, cw = (o.cuffTrimW ?? o.trimW ?? 0.04) * s;
    trims = trimBand(m, {
      filter: (cx, cy) => isTop(cx, cy), sdf, color: (x, y, z) => scale3(o.trim, mottle(x, y, z, 0.05, 20)), color2: o.trimLining ?? o.trim,
      widthFn: (x) => (Math.abs(x) > 0.25 * s ? cw : tw), raise: 0.0022 * s, roll: 0.006 * s,
    });
  }
  // rolled hems on the remaining visible edges
  m = hem(m, 0.0055 * s, 0.018 * s, (x, y) => !o.trim && y > waistY + 0.03 * s);
  ctx.asm.add(o.mat ?? 'cloth', m, { uvScale: o.uvScale ?? 3.5 });
  if (trims) ctx.asm.add(o.trimMat ?? o.mat ?? 'cloth', trims, { uvScale: 5 });
  return m;
}

/** roundCone primitive without importing (plain object with d). */
function roundConeP(a, b, ra, rb) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb, a2 = l2 - rr * rr, il2 = 1 / l2;
  return {
    d(x, y, z) {
      const pax = x - a.x, pay = y - a.y, paz = z - a.z;
      const yy = pax * bax + pay * bay + paz * baz, zz = yy - l2;
      const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
      const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
      const k = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
      if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
      return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - ra;
    },
  };
}

/** Ellipsoid with explicit axes (unit vectors ax, ay, az) and radii r = [rx, ry, rz]. */
function ellipsoidFrame(c, r, ax, ay, az) {
  const [rx, ry, rz] = r;
  return {
    d(x, y, z) {
      const px = x - c.x, py = y - c.y, pz = z - c.z;
      const lx = px * ax.x + py * ax.y + pz * ax.z, ly = px * ay.x + py * ay.y + pz * ay.z, lz = px * az.x + py * az.y + pz * az.z;
      const k0 = Math.hypot(lx / rx, ly / ry, lz / rz), k1 = Math.hypot(lx / (rx * rx), ly / (ry * ry), lz / (rz * rz));
      return k1 < 1e-9 ? -Math.min(rx, ry, rz) : k0 * (k0 - 1) / k1;
    },
  };
}
export { roundConeP, ellipsoidFrame };

// ---------------------------------------------------------------------------------------------------------------
// inner layer (visible in the V of the collar)
// ---------------------------------------------------------------------------------------------------------------

export function innerLayer(ctx, o) {
  const { J, s, prims } = ctx;
  const t = (o.t ?? 0.012) * s;
  const items = [];
  for (const p of prims.torso) if (['chest', 'pec', 'trap', 'upperback'].includes(p.tag)) items.push(inflate(p, t, Math.max(p.k, 0.05 * s)));
  items.push(inflate(prims.neck[0], (o.neckT ?? 0.011) * s, 0.04 * s));
  const sdf = garmentSDF(items, 0.04 * s);
  const ny = J.neck.y;
  const vpoly = (o.vShape ?? [[0.05, -0.005], [0.05, 0.22], [-0.062, 0.22], [-0.062, -0.005], [-0.03, -0.13]]).map(([px, py]) => [px * s, ny + py * s]);
  const collarY = ny + (o.collarDY ?? -0.004) * s, neckR = (o.neckR ?? 0.075) * s;
  const clip = (x, y, z) => {
    const zc = mix(-0.032 * s, 0, clamp((y - ny + 0.04 * s) / (0.17 * s), 0, 1));
    const rn = Math.hypot(x, z - zc);
    let c = Math.min(y - collarY, neckR - rn);
    if (z > 0) c = Math.max(c, -sdPoly2(x, y, vpoly));
    return Math.max(c, (J.chest.y - 0.02 * s) - y, Math.abs(x) - 0.19 * s);
  };
  let m = shell({ sdf, box: [V(-0.22 * s, J.chest.y - 0.05 * s, -0.2 * s), V(0.22 * s, ny + 0.12 * s, 0.2 * s)], voxel: 0.012 * s, tris: 1600, clip });
  const ed = edgeDistances(m, (cx, cy) => (cy > J.chest.y + 0.15 * s ? 'collar' : null));
  const tw = (o.trimW ?? 0.014) * s;
  paint(m, {
    color: (x, y, z, v) => scale3(ed.collar && ed.collar[v] < tw ? o.trim : o.color, mottle(x, y, z, 0.04)),
    color2: o.color,
    cloth: [0.4, 0, 1, 0.9],
  });
  m = hem(m, 0.004 * s, 0.012 * s, (x, y) => y > J.chest.y + 0.12 * s);
  const W = bodyWeights(ctx);
  skinDense(m, (x, y, z, v, out) => W(x, y, z, out), RIG_SLOTS, 1);
  ctx.asm.add('cloth', m, { uvScale: 3.5 });
}

// ---------------------------------------------------------------------------------------------------------------
// sash / belt with knot and tails
// ---------------------------------------------------------------------------------------------------------------

/**
 * o = { y0, y1, t, color, pattern ('silk'|'rope'|'leather'), knot: [x, dy] (front position), tails: [len...],
 *       tailW, mat, cord (thin cord colour on top), name }
 */
export function sash(ctx, o) {
  const { J, s, prims } = ctx;
  const t = (o.t ?? 0.042) * s;
  const items = [];
  for (const p of prims.torso) if (['waist', 'pelvis', 'belly'].includes(p.tag)) items.push(inflate(p, t, 0.06 * s));
  const y0 = o.y0 * s, y1 = o.y1 * s;
  // front surface z at the knot
  const probe = unionSDF(items, 0.06 * s);
  const kx = (o.knot?.[0] ?? 0.085) * s, ky = (y0 + y1) * 0.5 + (o.knot?.[1] ?? -0.005) * s;
  let kz = 0.3 * s; while (kz > 0 && probe(kx, ky, kz) > 0) kz -= 0.002;
  const knotC = V(kx, ky, kz + 0.012 * s);
  if (o.knot !== null) {
    // square knot: a flat wrapped core with two short loops angled out
    items.push({ ...ellipsoidFrame(knotC, [0.022 * s, 0.03 * s, 0.014 * s], V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)), k: 0.012 * s });
    for (const sg of [-1, 1]) {
      const ax = V(sg * 0.85, 0.5, 0).normalize(), ay = V(-0.5 * sg, 0.85, 0).normalize();
      items.push({ ...ellipsoidFrame(knotC.clone().add(V(sg * 0.026 * s, 0.006 * s, -0.004 * s)), [0.026 * s, 0.013 * s, 0.01 * s], ax, ay, V(0, 0, 1)), k: 0.01 * s });
    }
  }
  const disp = (x, y, z) => {
    // wrapped layers: shallow horizontal ridges + a few wrinkles
    const th = Math.atan2(x, z);
    return s * (0.0018 * Math.sin((y - y0) / (y1 - y0) * Math.PI * (o.wraps ?? 3)) + 0.0014 * Math.sin(th * 9 + y * 60));
  };
  const sdf = garmentSDF(items, 0.06 * s, disp, 0.004 * s);
  let m = shell({
    sdf, box: [V(-0.26 * s, y0 - 0.05 * s, -0.22 * s), V(0.26 * s, y1 + 0.05 * s, 0.26 * s)], voxel: 0.011 * s, tris: 2000,
    clip: (x, y, z) => Math.max(y0 - y, y - y1) - (Math.hypot(x - knotC.x, y - knotC.y, z - knotC.z) < 0.05 * s ? 0.02 * s : 0),
  });
  const ao = sdfAO(m, sdf, { dist: 0.03 * s });
  const c = o.color;
  paint(m, {
    color: (x, y, z) => {
      const e = Math.min(y - y0, y1 - y) / (y1 - y0);
      const edge = o.pattern === 'silk' ? 1 + 0.12 * sstep(0.12, 0.02, e) : 1;
      return scale3(c, mottle(x, y, z, 0.05, 14) * edge);
    },
    color2: scale3(c, 0.7), cloth: (x, y, z, v) => [0.6, 0, 1, ao[v]],
  });
  m = hem(m, 0.004 * s, 0.01 * s);
  const W = bodyWeights(ctx);
  skinDense(m, (x, y, z, v, out) => W(x, y, z, out), RIG_SLOTS, 2);
  ctx.asm.add(o.mat ?? 'cloth', m, { uvScale: 4 });
  // cord over the sash
  if (o.cord) {
    const ring = [];
    const yc = y1 - 0.006 * s;
    for (let i = 0; i <= 40; i++) {
      const th = i / 40 * TAU;
      let r = 0.1 * s; const dx = Math.sin(th), dz = Math.cos(th);
      while (r < 0.35 * s && sdf(dx * r, yc, dz * r) < 0) r += 0.002;
      ring.push([dx * (r + 0.003 * s), yc + 0.004 * s * Math.sin(th * 3), dz * (r + 0.003 * s)]);
    }
    const cm = tube(ring, 0.0045 * s, { sides: 6, caps: false });
    paint(cm, { color: o.cord, color2: o.cord, cloth: [0, 0, 1, 0.8] });
    skinDense(cm, (x, y, z, v, out) => W(x, y, z, out), RIG_SLOTS, 1);
    ctx.asm.add('cloth', cm, { uvScale: 20 });
  }
  // tails
  if (o.tails?.length) {
    o.tails.forEach((len, i) => {
      const dx = (i === 0 ? -1 : 1) * 0.018 * s;
      const start = knotC.clone().add(V(dx, -0.02 * s, 0.012 * s));
      ribbon(ctx, {
        name: `${o.name ?? 'sash'}Tail${i}`, parent: 'hips', start, dir: V(i === 0 ? -0.08 : 0.1, -1, 0.12).normalize(), length: len * s,
        n: o.tailNodes ?? 8, width: (o.tailW ?? 0.07) * s * (i === 0 ? 1 : 0.9), side: V(1, 0, -0.15).normalize(), color: c, color2: scale3(c, 0.75),
        mask: COL.LEGS | COL.PELVIS, radius: 0.022, drag: 2.6, flutter: 0.9, fringe: o.fringe ?? true, mat: o.mat ?? 'cloth', twist: i === 0 ? 0.4 : -0.3,
      });
    });
  }
  return { knot: knotC, sdf };
}

/**
 * A ribbon on a cloth chain. o = { name, parent, start (Vector3), dir, length, n, width, side, color, color2, mask,
 * radius, drag, flutter, fringe, twist (rad over the length), taper, nodes (explicit [[x,y,z]]) }
 */
export function ribbon(ctx, o) {
  const s = ctx.s;
  const n = o.n ?? 8;
  const nodes = o.nodes ?? Array.from({ length: n }, (_, i) => o.start.clone().addScaledVector(o.dir, o.length * i / (n - 1)).toArray());
  const c = ctx.rig.chain({
    name: o.name, parent: o.parent, nodes, pin: o.pin ?? [1], side: o.side.toArray(), radius: o.radius ?? 0.02,
    mask: o.mask ?? 0, drag: o.drag ?? 2.2, stiff: o.stiff ?? 0.15, flutter: o.flutter ?? 0.8, gravity: o.gravity ?? 1,
  });
  // mesh: rows along the chain (Catmull-Rom through the nodes), 3 columns across (slight cupping)
  const pts = catmull(nodes.map(p => V(...p)), (n - 1) * 4 + 1);
  const rows = pts.length, cols = 3;
  const P = [], UV = [], I = [], SI = [], SW = [];
  const side = o.side.clone().normalize();
  for (let r = 0; r < rows; r++) {
    const u = r / (rows - 1);
    const tan = pts[Math.min(r + 1, rows - 1)].clone().sub(pts[Math.max(r - 1, 0)]).normalize();
    const nrm = side.clone().cross(tan).normalize();
    const sd = tan.clone().cross(nrm).normalize().applyAxisAngle(tan, (o.twist ?? 0) * u);
    const nd = tan.clone().cross(sd).normalize();
    const w = o.width * (1 - (o.taper ?? 0.15) * u);
    const f = u * (n - 1), i0 = Math.min(Math.floor(f), n - 2), tt = f - i0;
    for (let k = 0; k < cols; k++) {
      const a = k / (cols - 1) - 0.5;
      const cup = (1 - 4 * a * a) * 0.004 * s;
      const p = pts[r].clone().addScaledVector(sd, a * w).addScaledVector(nd, cup);
      P.push(p.x, p.y, p.z); UV.push(a * o.width * 10, u * o.length * 10);
      SI.push(c.bone0 + i0, c.bone0 + i0 + 1, 0, 0); SW.push(1 - tt, tt, 0, 0);
    }
  }
  for (let r = 0; r < rows - 1; r++) for (let k = 0; k < cols - 1; k++) {
    const a = r * cols + k, b = a + 1, cc = a + cols + 1, d = a + cols;
    I.push(a, b, cc, a, cc, d);
  }
  let m = { positions: new Float32Array(P), normals: new Float32Array(P.length), indices: new Uint32Array(I), uvs: new Float32Array(UV), extra: {} };
  computeNormals(m);
  m.extra.skinIndex = { size: 4, array: new Float32Array(SI) };
  m.extra.skinWeight = { size: 4, array: new Float32Array(SW) };
  paint(m, { color: (x, y, z) => scale3(o.color, mottle(x, y, z, 0.05, 20)), color2: o.color2 ?? scale3(o.color, 0.75), cloth: [0.9, 0.8, 1, 1] });
  const parts = [m];
  // fringe at the end: short threads continuing the last segment
  if (o.fringe) {
    const last = pts[rows - 1], prev = pts[rows - 2];
    const tan = last.clone().sub(prev).normalize();
    const nrm = side.clone().cross(tan).normalize(), sd = tan.clone().cross(nrm).normalize().applyAxisAngle(tan, o.twist ?? 0);
    const w = o.width * (1 - (o.taper ?? 0.15));
    for (let k = 0; k < 7; k++) {
      const a = k / 6 - 0.5;
      const p0 = last.clone().addScaledVector(sd, a * w * 0.9);
      const p1 = p0.clone().addScaledVector(tan, 0.035 * s * (0.8 + 0.4 * Math.abs(Math.sin(k * 2.3))));
      const f = tube([p0.toArray(), p1.toArray()], (tt) => 0.0018 * s * (1 - 0.6 * tt), { sides: 3, caps: false });
      f.extra.skinIndex = { size: 4, array: new Float32Array(f.positions.length / 3 * 4).map((_, i) => (i % 4 === 0 ? c.bone0 + n - 1 : 0)) };
      f.extra.skinWeight = { size: 4, array: new Float32Array(f.positions.length / 3 * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)) };
      paint(f, { color: scale3(o.color, 0.9), color2: scale3(o.color, 0.7), cloth: [0.9, 1, 1, 1] });
      parts.push(f);
    }
  }
  ctx.asm.add(o.mat ?? 'cloth', merge(parts), { uvScale: 5 });
  return c;
}

// ---------------------------------------------------------------------------------------------------------------
// skirt: ring of cloth chains split into panels
// ---------------------------------------------------------------------------------------------------------------

/**
 * o = { name, y0, hemY, n (chains), rows: [node heights], pins: [...], slits: [{angle (rad, 0 = front, +π/2 = left),
 *       top}], color, trim, trimW, lining, clear: [top, hip, hem], flare, folds: {n, amp}, drag, dirt, zc,
 *       hemFront (front hem offset, m), stiff }
 */
export function skirt(ctx, o) {
  const { J, s, prims } = ctx;
  const bodyU = unionSDF([...prims.torso, ...prims.legs.L, ...prims.legs.R], 0.03);
  // clear the body AND the garments under the skirt (trousers)
  const bodySdf = o.under ? (x, y, z) => Math.min(bodyU(x, y, z), o.under(x, y, z)) : bodyU;
  const y0 = o.y0 * s, hemY = o.hemY * s, zc = (o.zc ?? -0.005) * s;
  const N = o.n ?? 20;
  const NU = o.nu ?? 100, NY = o.ny ?? 26;
  // --- body extent → rest radius field r(θ, y)
  const THs = 96, YS = 40;
  const yAt = (j) => y0 + (hemY - 0.06 * s - y0) * (j / (YS - 1));
  const R = new Float32Array(THs * YS);
  const clear = o.clear ?? [0.02, 0.03, 0.05];
  const yHip = J.hips.y - 0.04 * s;
  for (let i = 0; i < THs; i++) {
    const th = i / THs * TAU, dx = Math.sin(th), dz = Math.cos(th);
    let prev = 0;
    for (let j = 0; j < YS; j++) {
      const y = yAt(j);
      // sphere-trace inward from outside: the first hit is the outermost body surface on this ray
      let rb = 0, rt = 0.45 * s;
      for (let it = 0; it < 48; it++) {
        const d = bodySdf(dx * rt, y, zc + dz * rt);
        if (d < 0.0015) { rb = rt; break; }
        rt -= Math.max(d, 0.003);
        if (rt < 0.01) break;
      }
      const cl = (y > yHip ? mix(clear[1], clear[0], clamp((y - yHip) / (y0 - yHip), 0, 1)) : mix(clear[1], clear[2], clamp((yHip - y) / (yHip - hemY), 0, 1))) * s;
      let r = rb + cl;
      if (j > 0) r = Math.max(r, prev + (yAt(j - 1) - y) * (y < yHip ? (o.flare ?? 0.1) : 0));
      R[i * YS + j] = r; prev = r;
    }
  }
  // circular smoothing in θ
  for (let pass = 0; pass < 3; pass++) for (let j = 0; j < YS; j++) {
    const tmp = new Float32Array(THs);
    for (let i = 0; i < THs; i++) tmp[i] = (R[((i + THs - 1) % THs) * YS + j] + 2 * R[i * YS + j] + R[((i + 1) % THs) * YS + j]) / 4;
    for (let i = 0; i < THs; i++) R[i * YS + j] = tmp[i];
  }
  const rAt = (th, y) => {
    th = ((th % TAU) + TAU) % TAU;
    const fi = th / TAU * THs, i0 = Math.floor(fi) % THs, i1 = (i0 + 1) % THs, ti = fi - Math.floor(fi);
    const fj = clamp((y - y0) / (hemY - 0.06 * s - y0) * (YS - 1), 0, YS - 1), j0 = Math.min(Math.floor(fj), YS - 2), tj = fj - j0;
    const a = R[i0 * YS + j0] * (1 - tj) + R[i0 * YS + j0 + 1] * tj, b = R[i1 * YS + j0] * (1 - tj) + R[i1 * YS + j0 + 1] * tj;
    return a * (1 - ti) + b * ti;
  };
  // hem height per angle (front can be shorter), with irregularity
  const hemAt = (th) => hemY + (o.hemFront ?? 0) * s * Math.max(0, Math.cos(th)) + 0.008 * s * (vnoise3(Math.cos(th) * 3, Math.sin(th) * 3, 1.7) * 2 - 1);
  // --- chains
  const rows = o.rows.map(y => y * s);
  const nr = rows.length;
  const chainAng = (k) => (k + 0.5) / N * TAU + (o.phase ?? 0);
  const chains = [];
  for (let k = 0; k < N; k++) {
    const th = chainAng(k), dx = Math.sin(th), dz = Math.cos(th);
    const nodes = rows.map((y, i) => {
      const yy = i === nr - 1 ? hemAt(th) : y;
      const r = rAt(th, yy);
      return [dx * r, yy, zc + dz * r];
    });
    chains.push(ctx.rig.chain({
      name: `${o.name}${k}`, parent: 'hips', nodes, pin: o.pins, side: [Math.cos(th), 0, -Math.sin(th)],
      radius: o.radius ?? 0.022, mask: COL.LEGS | COL.PELVIS, drag: o.drag ?? 1.6, stiff: o.stiff ?? 0.35, flutter: o.flutter ?? 0.5,
      gravity: 1, ftl: 1.03,
    }));
  }
  // slit lookup: which chain gap each slit falls in
  const slits = (o.slits ?? []).map(sl => {
    const a = ((sl.angle % TAU) + TAU) % TAU;
    const g = Math.floor(((a - (o.phase ?? 0)) / TAU * N - 0.5 + N) % N);
    return { angle: a, top: sl.top * s, gap: g };
  });
  const gapSlit = (k) => slits.find(sl => sl.gap === k);
  const gapOpen = (k, y) => { const sl = gapSlit(k); return sl && y < sl.top - 1e-4; };
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    for (let i = 0; i < nr; i++) {
      if (!gapOpen(k, rows[i])) ctx.rig.link(chains[k].chain, i, chains[k2].chain, i, 1);
      if (i < nr - 1 && !gapOpen(k, rows[i + 1])) {
        ctx.rig.link(chains[k].chain, i, chains[k2].chain, i + 1, 0.35);
        ctx.rig.link(chains[k2].chain, i, chains[k].chain, i + 1, 0.35);
      }
    }
  }
  // --- mesh columns: uniform angles + duplicated seam columns at every slit
  const cols = [];
  const slitAngles = slits.map(sl => sl.angle).sort((a, b) => a - b);
  for (let i = 0; i < NU; i++) {
    const th = i / NU * TAU;
    // keep uniform columns away from the seams (a column inside the cut would bridge the slit)
    if (slitAngles.some(a => Math.abs(((th - a + Math.PI * 3) % TAU) - Math.PI) < 0.35 * TAU / NU)) continue;
    cols.push({ th, seam: 0 });
  }
  for (const sl of slits) { cols.push({ th: sl.angle - 1e-4, seam: -1, slit: sl }); cols.push({ th: sl.angle + 1e-4, seam: 1, slit: sl }); }
  // extra columns at the trim edge beside each slit so the band colour switches crisply
  if (o.trim) {
    const twA = (o.trimW ?? 0.045) * s / 0.22;
    for (const sl of slits) for (const sg of [-1, 1]) for (const d of [twA - 0.012, twA + 0.012]) {
      const th = ((sl.angle + sg * d) % TAU + TAU) % TAU;
      cols.push({ th, seam: 0 });
    }
  }
  cols.sort((a, b) => a.th - b.th);
  const NC = cols.length;
  // row heights: uniform in v; snap each slit top to its nearest row
  // rows: NY-3 from the waist to the top of the hem band, then 3 inside the band (crisp trim edge)
  const twH = (o.trimW ?? 0.045) * s;
  const vRow = (j) => (j < NY - 3 ? j / (NY - 4) * 0.93 : 0.93 + (j - (NY - 4)) / 3 * 0.07);
  const yRow = (th, j) => {
    const h = hemAt(th);
    if (j < NY - 3) return mix(y0, h + twH, Math.pow(j / (NY - 4), 0.92));
    return [h + twH - 0.004 * s, h + twH * 0.45, h][j - (NY - 3)];
  };
  const foldN = o.folds?.n ?? 14, foldA = (o.folds?.amp ?? 0.016) * s;
  const P = new Float32Array(NC * NY * 3), UV = new Float32Array(NC * NY * 2);
  const SI = new Float32Array(NC * NY * 4), SW = new Float32Array(NC * NY * 4);
  const col3 = new Float32Array(NC * NY * 3), col23 = new Float32Array(NC * NY * 3), cl4 = new Float32Array(NC * NY * 4);
  const remap = new Int32Array(NC * NY);
  const chainOf = (th) => { const f = ((th - (o.phase ?? 0)) / TAU * N - 0.5 + N * 4) % N; const k = Math.floor(f); return [k, f - k]; };
  const base = o.color, trim = o.trim ?? base, lining = o.lining ?? scale3(base, 0.82), tw = (o.trimW ?? 0.045) * s;
  for (let c = 0; c < NC; c++) {
    const { th, seam, slit } = cols[c];
    const dx = Math.sin(th), dz = Math.cos(th);
    for (let j = 0; j < NY; j++) {
      const idx = c * NY + j;
      const y = yRow(th, j);
      const v = vRow(j);
      remap[idx] = idx;
      // seam columns above the slit top are welded to their twin
      if (seam === 1 && y >= slit.top - 1e-4) remap[idx] = (c - 1) * NY + j;
      const r = rAt(th, y);
      // folds: flutes growing toward the hem; phase wobble so they are not a perfect sine
      const fa = foldA * Math.pow(sstep(0.08, 1, v), 1.1);
      const wob = vnoise3(Math.cos(th) * 2.2, Math.sin(th) * 2.2, v * 1.5) * 2.4;
      const fold = fa * (Math.sin(th * foldN + wob) * 0.75 + 0.25 * Math.sin(th * foldN * 2.1 + wob * 1.7));
      const rr = r + fold;
      P[idx * 3] = dx * rr; P[idx * 3 + 1] = y; P[idx * 3 + 2] = zc + dz * rr;
      UV[idx * 2] = th * 0.3 * s; UV[idx * 2 + 1] = y;
      // weights: bilinear between the two chains of this gap and the two node rows around y
      let [k, tk] = chainOf(th);
      const open = gapOpen(k, y);
      if (open) {
        // inside an open slit gap: the panel edge rides its own chain only
        const sl = gapSlit(k);
        const before = ((th - sl.angle + TAU * 1.5) % TAU) - Math.PI < 0; // th below the slit angle
        tk = before ? 0 : 1;
      }
      let i0 = 0;
      while (i0 < nr - 2 && y < rows[i0 + 1]) i0++;
      const yTop = rows[i0], yBot = i0 + 1 === nr - 1 ? hemAt(th) : rows[i0 + 1];
      const tv = clamp((yTop - y) / Math.max(yTop - yBot, 1e-4), 0, 1);
      const kA = chains[k].bone0, kB = chains[(k + 1) % N].bone0;
      SI[idx * 4] = kA + i0; SW[idx * 4] = (1 - tk) * (1 - tv);
      SI[idx * 4 + 1] = kB + i0; SW[idx * 4 + 1] = tk * (1 - tv);
      SI[idx * 4 + 2] = kA + i0 + 1; SW[idx * 4 + 2] = (1 - tk) * tv;
      SI[idx * 4 + 3] = kB + i0 + 1; SW[idx * 4 + 3] = tk * tv;
      // colour: trim along the hem and the slit edges; dust near the ground
      let band = y - hemAt(th) < tw - 0.002 * s ? 1 : 0;
      const twA = tw / 0.22;
      for (const sl of slits) if (y < sl.top - 0.02 * s) { const ad = Math.abs(((th - sl.angle + Math.PI * 3) % TAU) - Math.PI); if (ad < twA) band = 1; }
      if (!o.trim) band = 0;
      const mt = mottle(dx * r, y, dz * r, o.mottle ?? 0.05) * (o.dirt ? dust(y, s, o.dirt) : 1);
      const cc = mix3(scale3(mix3(base, trim, band), mt), mix3(base, DUST_TINT, 0.3), o.dirt ? 0.25 * o.dirt * sstep(0.3 * s, 0.05 * s, y) : 0);
      col3.set(cc, idx * 3);
      col23.set(mix3(lining, trim, band * 0.7), idx * 3);
      // AO: deeper in the fold valleys, darker high under the sash
      const ao = (1 - 0.35 * clamp(-fold / Math.max(foldA, 1e-4), 0, 1) * sstep(0, 0.4, v)) * mix(0.72, 1, sstep(0, 0.2, v));
      cl4.set([1, 0.2 + 0.8 * v, 1, ao], idx * 4);
    }
  }
  const I = [];
  for (let c = 0; c < NC; c++) {
    const c2 = (c + 1) % NC;
    if (cols[c].seam === -1 && cols[c2].seam === 1) continue; // across an open slit: no faces
    for (let j = 0; j < NY - 1; j++) {
      const a = remap[c * NY + j], b = remap[c2 * NY + j], cc = remap[c2 * NY + j + 1], d = remap[c * NY + j + 1];
      I.push(a, cc, b, a, d, cc);
    }
  }
  let m = { positions: P, normals: new Float32Array(P.length), indices: new Uint32Array(I), uvs: UV, extra: {
    color: { size: 3, array: col3 }, color2: { size: 3, array: col23 }, cloth: { size: 4, array: cl4 },
    skinIndex: { size: 4, array: SI }, skinWeight: { size: 4, array: SW },
  } };
  // drop welded duplicates, make normals face outward
  m = compactUsed(m);
  computeNormals(m);
  const Nn = m.normals, Pp = m.positions;
  let outward = 0;
  for (let v = 0; v < Pp.length; v += 3) outward += Nn[v] * Pp[v] + Nn[v + 2] * (Pp[v + 2] - zc);
  if (outward < 0) { const Ii = m.indices; for (let t = 0; t < Ii.length; t += 3) { const tmp = Ii[t + 1]; Ii[t + 1] = Ii[t + 2]; Ii[t + 2] = tmp; } computeNormals(m); }
  m = hem(m, 0.006 * s, 0.02 * s, (x, y) => y < y0 - 0.05 * s);
  ctx.asm.add('cloth', m, { uvScale: 3.5 });
  return { chains, rAt };
}

/** Remove vertices no triangle references (keeps every extra + uvs). */
function compactUsed(m) {
  const nv = m.positions.length / 3;
  const map = new Int32Array(nv).fill(-1);
  let n = 0;
  for (const i of m.indices) if (map[i] < 0) map[i] = n++;
  const out = { positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), uvs: new Float32Array(n * 2), indices: new Uint32Array(m.indices.length), extra: {} };
  for (const k in m.extra) out.extra[k] = { size: m.extra[k].size, array: new Float32Array(n * m.extra[k].size) };
  for (let v = 0; v < nv; v++) {
    const r = map[v]; if (r < 0) continue;
    for (let c = 0; c < 3; c++) out.positions[r * 3 + c] = m.positions[v * 3 + c];
    out.uvs[r * 2] = m.uvs[v * 2]; out.uvs[r * 2 + 1] = m.uvs[v * 2 + 1];
    for (const k in m.extra) { const sz = m.extra[k].size; for (let c = 0; c < sz; c++) out.extra[k].array[r * sz + c] = m.extra[k].array[v * sz + c]; }
  }
  for (let i = 0; i < m.indices.length; i++) out.indices[i] = map[m.indices[i]];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// legs: trousers, leg wraps, shoes
// ---------------------------------------------------------------------------------------------------------------

/** o = { t, bag, y0 (waist), y1 (bottom), color, dirt, knee (patch colour) } */
export function trousers(ctx, o) {
  const { J, s, prims } = ctx;
  const t = (o.t ?? 0.026) * s, bag = o.bag ?? 1;
  const items = [];
  for (const p of prims.torso) if (['pelvis', 'glute', 'waist'].includes(p.tag)) items.push(inflate(p, t, 0.06 * s));
  for (const side of ['L', 'R']) {
    for (const p of prims.legs[side]) if (['thigh', 'quads', 'outerthigh', 'knee', 'shin', 'calf'].includes(p.tag)) items.push(inflate(p, t, 0.05 * s));
    const ul = J[`upperLeg.${side}`], ll = J[`lowerLeg.${side}`];
    items.push({ ...roundConeP(ul.clone().add(V(0, 0.02 * s, 0)), ll, (0.1 + 0.02 * bag) * s * ctx.b.leg, (0.075 + 0.015 * bag) * s * ctx.b.leg), k: 0.06 * s });
    items.push({ ...roundConeP(ll, ll.clone().add(V(0, -0.16 * s, -0.01 * s)), (0.075 + 0.015 * bag) * s * ctx.b.leg, (0.064 + 0.01 * bag) * s * ctx.b.leg), k: 0.05 * s });
  }
  const disp = (x, y, z) => {
    // knee and ankle compression folds, crotch drag lines
    const lx = x > 0 ? x - J['upperLeg.L'].x : x - J['upperLeg.R'].x;
    const th = Math.atan2(lx, z);
    const kn = J['lowerLeg.L'].y;
    return s * (0.004 * Math.sin((y - kn) * 70 + th * 1.5) * Math.exp(-((y - kn) ** 2) / 0.012)
      + 0.0035 * Math.sin(th * 3 + y * 26) * sstep(kn, kn - 0.1 * s, y)
      + 0.002 * Math.sin(y * 45 + th * 2) * sstep(J.hips.y - 0.1 * s, J.hips.y - 0.2 * s, y));
  };
  const sdf = garmentSDF(items, 0.05 * s, disp, 0.008 * s);
  const y0 = (o.y0 ?? 1.03) * s, y1 = (o.y1 ?? 0.4) * s;
  let m = shell({ sdf, box: [V(-0.34 * s, y1 - 0.04 * s, -0.24 * s), V(0.34 * s, y0 + 0.04 * s, 0.24 * s)], voxel: 0.016 * s, tris: o.tris ?? 3600, clip: (x, y, z) => Math.max(y - y0, y1 - y) });
  const ao = sdfAO(m, sdf, { dist: 0.05 * s });
  paint(m, {
    color: (x, y, z) => scale3(o.color, mottle(x, y, z, 0.06) * (o.dirt ? dust(y, s, o.dirt) : 1) * (o.knee && Math.abs(y - J['lowerLeg.L'].y) < 0.05 * s && z > 0.02 ? 0.8 : 1)),
    color2: scale3(o.color, 0.7), cloth: (x, y, z, v) => [0.5, 0.05, 1, ao[v]],
  });
  m = hem(m, 0.005 * s, 0.012 * s, (x, y) => y < y0 - 0.1 * s);
  const W = bodyWeights(ctx);
  skinDense(m, (x, y, z, v, out) => W(x, y, z, out), RIG_SLOTS, 2);
  ctx.asm.add('cloth', m, { uvScale: 3.5 });
  return { sdf };
}

/** Spiral leg wraps from the ankle to below the knee. o = { y0, y1, t, color, band, dirt } */
export function legWraps(ctx, o) {
  const { J, s, prims } = ctx;
  const t = (o.t ?? 0.013) * s;
  const items = [];
  const axis = {};
  for (const side of ['L', 'R']) {
    for (const p of prims.legs[side]) if (['shin', 'calf'].includes(p.tag)) items.push(inflate(p, t, 0.03 * s));
    axis[side] = [J[`lowerLeg.${side}`], J[`foot.${side}`]];
  }
  const y0 = (o.y0 ?? 0.1) * s, y1 = (o.y1 ?? 0.46) * s, bw = (o.band ?? 0.045) * s;
  const phaseAt = (x, y, z) => {
    const [a, b] = x > 0 ? axis.L : axis.R;
    const th = Math.atan2(x - a.x, z - mix(a.z, b.z, 0.5));
    return (y / bw + (x > 0 ? th : -th) / TAU);
  };
  const disp = (x, y, z) => {
    const ph = phaseAt(x, y, z);
    const f = ph - Math.floor(ph);
    // each wrap turn overlaps the one below: a raised lower edge
    const ridge = 0.0022 * s * sstep(0.0, 0.25, f) * (1 - f);
    const top = (o.flare ?? 0.02) * s * sstep(y1 - 0.08 * s, y1, y);
    return ridge + top;
  };
  const sdf = garmentSDF(items, 0.03 * s, disp, 0.024 * s);
  let m = shell({ sdf, box: [V(-0.25 * s, y0 - 0.03 * s, -0.16 * s), V(0.25 * s, y1 + 0.04 * s, 0.16 * s)], voxel: 0.0085 * s, tris: 2800, clip: (x, y, z) => Math.max(y - y1, y0 - y) });
  const ao = sdfAO(m, sdf, { dist: 0.02 * s, strength: 1.2 });
  paint(m, {
    color: (x, y, z) => {
      const ph = phaseAt(x, y, z), f = ph - Math.floor(ph);
      const k = (0.78 + 0.22 * sstep(0, 0.2, f)) * mottle(x, y, z, 0.07, 15) * (o.dirt ? dust(y, s, o.dirt * 1.3) : 1);
      return scale3(o.color, k);
    },
    color2: scale3(o.color, 0.7), cloth: (x, y, z, v) => [0.3, 0, 1, ao[v]],
  });
  m = hem(m, 0.004 * s, 0.008 * s);
  const W = bodyWeights(ctx);
  skinDense(m, (x, y, z, v, out) => W(x, y, z, out), RIG_SLOTS, 1);
  ctx.asm.add('cloth', m, { uvScale: 6 });
  // ties at the top: two cords around the calf
  if (o.ties) {
    for (const side of ['L', 'R']) {
      const [a] = axis[side];
      const yc = y1 - 0.02 * s;
      const ring = [];
      for (let i = 0; i <= 24; i++) {
        const th = i / 24 * TAU; const dx = Math.sin(th), dz = Math.cos(th);
        let r = 0.02 * s; while (r < 0.2 * s && sdf(a.x + dx * r, yc, a.z + dz * r) < 0) r += 0.0015;
        ring.push([a.x + dx * (r + 0.002 * s), yc - 0.006 * s * Math.cos(th), a.z + dz * (r + 0.002 * s)]);
      }
      const cm = tube(ring, 0.0028 * s, { sides: 5, caps: false });
      paint(cm, { color: o.ties, color2: o.ties, cloth: [0, 0, 1, 0.8] });
      skinDense(cm, (x, y, z, v, out) => W(x, y, z, out), RIG_SLOTS, 0);
      ctx.asm.add('cloth', cm, { uvScale: 20 });
    }
  }
}

/** Cloth shoes / boots / sandals. o = { top, color, sole, soleH, t, mat, boot } */
export function shoes(ctx, o) {
  const { J, s, prims } = ctx;
  const t = (o.t ?? 0.011) * s;
  const items = [];
  for (const side of ['L', 'R']) {
    for (const p of prims.legs[side]) if (['heel', 'arch', 'toe', 'shin', ...(o.boot ? ['calf'] : [])].includes(p.tag)) items.push(inflate(p, t, 0.025 * s));
    const ft = J[`foot.${side}`], to = J[`toes.${side}`];
    const sh = (o.soleH ?? 0.014) * s;
    // flat sole under heel → toe (slightly wider than the upper)
    const back = ft.z - 0.085 * s, front = to.z + 0.088 * s;
    const c = V(ft.x, sh, (back + front) * 0.5);
    items.push({ ...ellipsoidFrame(c, [0.052 * s, sh, (front - back) * 0.5], V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)), k: 0.012 * s });
  }
  const top = (o.top ?? 0.14) * s;
  const sdf = garmentSDF(items, 0.02 * s);
  let m = shell({ sdf, box: [V(-0.22 * s, -0.01, -0.14 * s), V(0.22 * s, top + 0.03 * s, 0.26 * s)], voxel: 0.0075 * s, tris: 2400, clip: (x, y, z) => Math.max(y - top, -y) });
  const ao = sdfAO(m, sdf, { dist: 0.02 * s });
  const soleY = (o.soleH ?? 0.014) * s * 1.6;
  paint(m, {
    color: (x, y, z) => (y < soleY ? scale3(o.sole ?? o.color, mottle(x, y, z, 0.05, 30)) : scale3(o.color, mottle(x, y, z, 0.06, 12) * (o.dirt ? dust(y, s, o.dirt) : 1))),
    color2: scale3(o.color, 0.6), cloth: (x, y, z, v) => [0.2, 0, 1, ao[v]],
  });
  m = hem(m, 0.004 * s, 0.01 * s);
  const W = bodyWeights(ctx);
  skinDense(m, (x, y, z, v, out) => W(x, y, z, out), RIG_SLOTS, 1);
  ctx.asm.add(o.mat ?? 'cloth', m, { uvScale: 6 });
}

// ---------------------------------------------------------------------------------------------------------------
// extras: vest, bracers, belt
// ---------------------------------------------------------------------------------------------------------------

/** Leather/fur vest: sleeveless open-front shell. o = { t, color, fur, y0, open, mat } */
export function vest(ctx, o) {
  robe(ctx, {
    ...o, sleeve: 'none', collar: 'none', t: o.t ?? 0.034, openFront: o.open ?? 0.07, waistY: o.y0 ?? 0.99, trim: o.fur, trimW: o.furW ?? 0.03,
    cuffTrimW: o.furW ?? 0.03, blouse: 0, folds: 0.4, bag: false, name: o.name ?? 'vest', mat: o.mat,
  });
}

/** Bracers: leather sleeves on the forearms. o = { color, mat, len } */
export function bracers(ctx, o) {
  const { s } = ctx;
  const parts = [];
  for (const side of ['L', 'R']) {
    const A = armFrame(ctx, side);
    const a = A.el.clone().lerp(A.wr, 0.3), b = A.wr.clone().addScaledVector(A.fx, -0.005 * s);
    const items = [];
    for (const p of ctx.prims.arms[side]) if (['forearm', 'forearmMass'].includes(p.tag)) items.push(inflate(p, (o.t ?? 0.012) * s, 0.02 * s));
    const sdf = garmentSDF(items, 0.02 * s, (x, y, z) => 0.0015 * s * Math.sin(((x - a.x) * A.fx.x + (y - a.y) * A.fx.y + (z - a.z) * A.fx.z) * 180), 0.002 * s);
    const lo = V(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)).addScalar(-0.1 * s), hi = V(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)).addScalar(0.1 * s);
    let m = shell({ sdf, box: [lo, hi], voxel: 0.007 * s, tris: 1800, clip: (x, y, z) => Math.max(axisCut(x, y, z, b, A.fx, 0.2), axisCut(x, y, z, a, A.fx.clone().negate(), 0.2)) });
    paint(m, { color: (x, y, z) => scale3(o.color, mottle(x, y, z, 0.1, 25)), color2: scale3(o.color, 0.6), cloth: [0, 0, 1, 0.9] });
    m = hem(m, 0.003 * s, 0.006 * s);
    parts.push(m);
  }
  const m = merge(parts);
  const W = bodyWeights(ctx);
  skinDense(m, (x, y, z, v, out) => W(x, y, z, out), RIG_SLOTS, 1);
  ctx.asm.add(o.mat ?? 'leather', m, { uvScale: 5 });
}
